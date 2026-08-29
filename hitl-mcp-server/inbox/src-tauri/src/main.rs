// A release build must not drag a console window along behind it; a debug
// build must keep stderr, because that is where `env_logger` writes and the
// whole of this binary's diagnostics with it.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backfill;
mod body;
mod capture;
mod detail;
mod identity;
mod reply;
mod session;
mod sink;
mod view;

use std::sync::{Arc, Mutex};

use hitl_store::{Event, Store};
use hitl_transport::ntfy::review::{AckWaiters, OutstandingReviews};
use hitl_transport::ntfy::subscribe::subscribe_loop;
use hitl_transport::status::ConnectionStatus;
use tauri::{Emitter, Manager};

use crate::body::BodyOutcome;
use crate::capture::{Pending, Queue};
use crate::detail::MessageDetail;
use crate::sink::{InboxSink, SharedStore};
use crate::view::{MessageList, SessionTree};

/// Emitted whenever a genuinely new event lands. The window's response is to
/// re-read both panes: the view is a function of the log, so there is nothing
/// finer-grained to send and nothing to keep in sync.
const CHANGED_EVENT: &str = "inbox-changed";

/// One page of the log. The Inbox folds in memory, so this bounds how much is
/// pulled per round trip, not how much it will look at.
const PAGE_SIZE: usize = 5_000;

/// Where the Inbox's own projection lives (spec §10).
///
/// `HITL_INBOX_DB` overrides it, for the same reason the archivist has an
/// override: `dirs::home_dir()` on Windows resolves through
/// `SHGetKnownFolderPath` and ignores `HOME`/`USERPROFILE`, so there is
/// otherwise no way to run this against a disposable database.
fn database_path() -> Result<std::path::PathBuf, String> {
    if let Some(path) = std::env::var_os("HITL_INBOX_DB") {
        let path = std::path::PathBuf::from(path);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
        }
        return Ok(path);
    }

    hitl_transport::paths::in_hitl_dir("inbox.db")
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// The whole log, paged out of SQLite.
///
/// The Inbox reads `events` and folds in memory rather than querying
/// `hitl_store`'s `messages` projection. Two reasons, both structural: that
/// table cannot carry `session_key` (the crate writes NULL there and its
/// connection is private, so nothing outside it can patch identity on), and
/// `rebuild()` would drop any identity that had been patched on anyway.
/// Folding here keeps the entire view a pure function of `(events, now)` —
/// which is what makes `view.rs` testable without a database at all.
fn all_events(store: &Store) -> Result<Vec<Event>, String> {
    let mut out: Vec<Event> = Vec::new();
    let mut cursor = 0i64;
    loop {
        let page = store
            .events_since(cursor, PAGE_SIZE)
            .map_err(|e| format!("could not read the event log: {e}"))?;
        let Some(last) = page.last() else { break };
        cursor = last.seq;
        out.extend(page);
    }
    Ok(out)
}

fn with_events<T>(
    store: &SharedStore,
    f: impl FnOnce(&[Event], u64) -> T,
) -> Result<T, String> {
    let guard = store.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let events = all_events(&guard)?;
    Ok(f(&events, now_secs()))
}

/// Pane 1 — the project → session tree (spec §6).
#[tauri::command]
fn list_sessions(store: tauri::State<'_, SharedStore>) -> Result<SessionTree, String> {
    with_events(&store, view::build_tree)
}

/// Pane 2 — the message list (spec §7).
///
/// `session_key` is the `scopeKey` handed out by [`list_sessions`]: `all`,
/// `unattributed`, `project:<key>` or `session:<key>`. The UI never composes
/// one; it passes back what the tree gave it. `filter` of `null` means "you
/// pick", and resolves to `needs_you` when anything in scope is pending.
#[tauri::command]
fn list_messages(
    store: tauri::State<'_, SharedStore>,
    session_key: Option<String>,
    filter: Option<String>,
) -> Result<MessageList, String> {
    with_events(&store, |events, now| {
        view::build_list(events, session_key.as_deref(), filter.as_deref(), now)
    })
}

/// Pane 3 — one message, whole (spec §8).
///
/// Separate from [`list_messages`] on purpose. Pane 2 draws a hundred rows and
/// needs a header for each; pane 3 draws one message and needs everything about
/// it. Folding the payload into every row would put a plan body behind every
/// list repaint.
#[tauri::command]
fn get_message(
    store: tauri::State<'_, SharedStore>,
    message_id: String,
) -> Result<Option<MessageDetail>, String> {
    with_events(&store, |events, now| {
        detail::build_detail(events, &message_id, now)
    })
}

/// The plan body behind a `plan_review`, fetched from wherever it lives.
///
/// **Only ever called for a selected message.** `list_messages` is a pure
/// function of `(events, now)` and stays one; a body fetch on the paint path
/// would make pane 2 render differently depending on whether the archivist
/// happened to be running (spec §11).
#[tauri::command]
async fn get_body(
    store: tauri::State<'_, SharedStore>,
    pending: tauri::State<'_, Arc<Pending>>,
    message_id: String,
) -> Result<BodyOutcome, String> {
    // The request event is copied out and the lock released before anything is
    // awaited: holding the store's mutex across a network round trip would stop
    // every ingest for as long as the archivist takes to answer.
    let request = {
        let guard = store.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let events = all_events(&guard)?;
        events
            .into_iter()
            .find(|e| e.msg_type == "plan_review" && e.message_id == message_id)
    };

    let Some(request) = request else {
        return Ok(BodyOutcome::Absent);
    };

    // Read per call rather than cached at startup, so adding the encryption key
    // to `~/.hitl/config.json` takes effect on the next selection instead of on
    // the next restart.
    let key = hitl_transport::config::load_config()
        .unwrap_or_default()
        .encryption_key;

    Ok(body::load(
        &store,
        &pending,
        &request,
        key.as_deref(),
        &backfill::archivist_base(),
    )
    .await)
}

fn init_logging() {
    // `HITL_LOG` matches the client's and the archivist's convention, so one
    // habit covers all three.
    env_logger::Builder::from_env(env_logger::Env::new().filter_or("HITL_LOG", "info"))
        .try_init()
        .ok();
}

/// Catch up on whatever the archivist holds that we do not.
///
/// Every failure here is logged and swallowed. The archivist is an
/// optimization, not a dependency (spec §11): with it stopped the Inbox still
/// works from ntfy's own cache replay.
async fn catch_up(store: SharedStore) {
    let base = backfill::archivist_base();
    let since = {
        let guard = store.lock().unwrap_or_else(|p| p.into_inner());
        guard.last_seq().unwrap_or(0)
    };

    match backfill::fetch(&base, since).await {
        Ok(body) => {
            let batch = backfill::parse_ndjson(&body);
            let guard = store.lock().unwrap_or_else(|p| p.into_inner());
            let ingested = backfill::ingest(&guard, &batch);
            log::info!("backfilled {ingested} events from the archivist at {base}");
        }
        Err(e) => log::info!("no backfill this run ({e}); falling back to ntfy's cache"),
    }
}

/// Chromium flags that keep the webview alive when its window is not in front.
///
/// WebView2 is Chromium, and Chromium assumes a window you cannot see is a
/// window nobody is waiting on: it throttles timers, deprioritises the
/// renderer, and stops compositing occluded windows entirely. That is right for
/// a browser tab and wrong for this app, whose entire job is to be sitting
/// behind whatever you are actually working in until an agent needs you.
///
/// The symptom is a window that looks hung and then "unfreezes" the moment it
/// is raised — a paused renderer, not a blocked one, which is why the process
/// stays Responding and burns no CPU while it happens.
///
/// Set through the environment rather than `additionalBrowserArgs` in
/// tauri.conf.json, because that key *replaces* the arguments Tauri passes by
/// default instead of adding to them, and has its own history of leaving
/// windows blank. The environment variable is additive.
/// `CalculateNativeWinOcclusion` is the one that matters, and the other three
/// are not a substitute for it. They govern how Chromium *prioritises* a
/// background window — its timers, its renderer's scheduling. Native window
/// occlusion is a separate mechanism that decides the window is not visible at
/// all and stops painting it outright; Chromium's own documentation says an
/// occluded window's foreground tabs are treated as background tabs, "rendering
/// stops, and js is throttled".
///
/// That distinction cost a round trip: with only the first three set, the
/// window still froze, and still woke on a click — because input is what pulls
/// a stopped compositor back, and nothing about timer priority was ever going
/// to prevent it.
///
/// The `msWeb*` entries are the ones Tauri passes by default. Chromium takes a
/// single `--disable-features` list and a second occurrence replaces the first
/// rather than extending it, so they have to be repeated here or turning
/// occlusion off would quietly turn those back on.
const WEBVIEW_FLAGS: &str = concat!(
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,",
    "CalculateNativeWinOcclusion ",
    "--disable-background-timer-throttling ",
    "--disable-renderer-backgrounding ",
    "--disable-backgrounding-occluded-windows",
);

fn main() {
    init_logging();
    log::info!("HITL Inbox {} starting", env!("CARGO_PKG_VERSION"));

    // Before anything can construct a webview, and appended rather than
    // assigned so a value set outside still wins its own flags.
    let flags = match std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") {
        Ok(existing) if !existing.trim().is_empty() => {
            format!("{existing} {WEBVIEW_FLAGS}")
        }
        _ => WEBVIEW_FLAGS.to_string(),
    };
    std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", &flags);
    log::info!("webview flags: {flags}");

    let path = match database_path() {
        Ok(path) => path,
        Err(e) => {
            log::error!("{e}");
            std::process::exit(1);
        }
    };
    let store = match Store::open(&path) {
        Ok(store) => Arc::new(Mutex::new(store)),
        Err(e) => {
            log::error!("could not open {}: {e}", path.display());
            std::process::exit(1);
        }
    };
    log::info!("inbox database at {}", path.display());

    // Shared between the submit command, which registers a waiter and blocks on
    // it, and the subscribe loop, which is the only thing that will ever see the
    // ack that resolves it.
    let waiters = Arc::new(AckWaiters::default());

    // Attachment bodies, from the sink that sees the envelope to the task that
    // fetches them. Created here so the sender can be handed to the sink and
    // the receiver to the fetcher, both inside `setup`.
    let (body_jobs, body_queue) = tokio::sync::mpsc::unbounded_channel();

    // Which of those fetches are still outstanding. Managed so `get_body` can
    // answer "downloading" instead of falling through to the archivist and
    // blaming a daemon that has nothing to do with this fetch.
    let pending = Arc::new(Pending::default());

    tauri::Builder::default()
        .manage(store)
        .manage(waiters.clone())
        .manage(pending.clone())
        // Nothing in the Inbox cancels a review — that is the popup client's
        // tray, and a second thing offering to release the same agent would be
        // two. `submit_review_response` still needs one to settle into.
        .manage(OutstandingReviews::default())
        .invoke_handler(tauri::generate_handler![
            list_sessions,
            list_messages,
            get_message,
            get_body,
            reply::submit_answer,
            reply::dismiss_notification,
            reply::submit_plan_review,
            reply::save_review_draft,
            reply::load_review_draft,
            reply::clear_review_draft
        ])
        .setup(move |app| {
            let store = app.state::<SharedStore>().inner().clone();

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(catch_up(store.clone()));
            // Off the subscribe loop on purpose: an attachment gets 60 s, and
            // awaiting one inline would stall every event behind it.
            tauri::async_runtime::spawn(capture::run(
                store.clone(),
                body_queue,
                pending.clone(),
            ));

            tauri::async_runtime::spawn(async move {
                let notify = handle.clone();
                let sink = InboxSink::new(
                    store,
                    waiters,
                    Queue::new(body_jobs, pending),
                    Box::new(move || {
                        if let Err(e) = notify.emit(CHANGED_EVENT, ()) {
                            log::warn!("could not notify the window of new events: {e}");
                        }
                    }),
                );
                // Never returns: it reconnects forever.
                subscribe_loop(&sink, &ConnectionStatus::default()).await;
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the HITL Inbox");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(id: &str, time: u64) -> hitl_transport::ntfy::subscribe::NtfyEvent {
        hitl_transport::ntfy::subscribe::NtfyEvent {
            id: id.to_string(),
            time,
            ..Default::default()
        }
    }

    #[test]
    fn the_whole_log_comes_back_across_more_than_one_page() {
        // The page size bounds one round trip, not what the view can see. A
        // loop that stopped at the first page would silently hide everything
        // past it — and the bug would only appear on a long-running install.
        let store = Store::open_in_memory().unwrap();
        for i in 1..=(PAGE_SIZE + 7) {
            store
                .append(
                    &event(&format!("ntfy-{i}"), 1_786_504_000 + i as u64),
                    &format!(r#"{{"type":"question","messageId":"q-{i}","question":"?"}}"#),
                )
                .unwrap();
        }

        assert_eq!(all_events(&store).unwrap().len(), PAGE_SIZE + 7);
    }

    #[test]
    fn an_empty_log_reads_as_no_events_rather_than_looping() {
        let store = Store::open_in_memory().unwrap();
        assert!(all_events(&store).unwrap().is_empty());
    }

    #[test]
    fn the_paged_read_preserves_ingest_order() {
        let store = Store::open_in_memory().unwrap();
        for i in 1..=3 {
            store
                .append(
                    &event(&format!("ntfy-{i}"), 100),
                    &format!(r#"{{"type":"question","messageId":"q-{i}","question":"?"}}"#),
                )
                .unwrap();
        }

        let ids: Vec<_> = all_events(&store)
            .unwrap()
            .iter()
            .map(|e| e.ntfy_id.clone())
            .collect();
        assert_eq!(ids, vec!["ntfy-1", "ntfy-2", "ntfy-3"]);
    }
}
