// A release build must not drag a console window along behind it; a debug
// build must keep stderr, because that is where `env_logger` writes and the
// whole of this binary's diagnostics with it.

mod backfill;
mod body;
mod capture;
mod detail;
mod identity;
mod reply;
mod session;
mod settings;
mod sink;
mod view;

use std::sync::atomic::{AtomicBool, Ordering};
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
    #[cfg(not(target_os = "android"))]
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

#[derive(Default)]
struct ServiceLifecycle {
    started: AtomicBool,
}

impl ServiceLifecycle {
    fn begin(&self) -> bool {
        self.started
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }
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

fn with_events<T>(store: &SharedStore, f: impl FnOnce(&[Event], u64) -> T) -> Result<T, String> {
    let guard = store
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let events = all_events(&guard)?;
    Ok(f(&events, now_secs()))
}

async fn with_events_async<T, F>(store: SharedStore, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&[Event], u64) -> T + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || with_events(&store, f))
        .await
        .map_err(|e| format!("the Inbox projection task did not run: {e}"))?
}

/// Pane 1 — the project → session tree (spec §6).
#[tauri::command]
async fn list_sessions(store: tauri::State<'_, SharedStore>) -> Result<SessionTree, String> {
    with_events_async(store.inner().clone(), view::build_tree).await
}

/// Pane 2 — the message list (spec §7).
///
/// `session_key` is the `scopeKey` handed out by [`list_sessions`]: `all`,
/// `unattributed`, `project:<key>` or `session:<key>`. The UI never composes
/// one; it passes back what the tree gave it. `filter` of `null` means "you
/// pick", and resolves to `needs_you` when anything in scope is pending.
#[tauri::command]
async fn list_messages(
    store: tauri::State<'_, SharedStore>,
    session_key: Option<String>,
    filter: Option<String>,
) -> Result<MessageList, String> {
    with_events_async(store.inner().clone(), move |events, now| {
        view::build_list(events, session_key.as_deref(), filter.as_deref(), now)
    })
    .await
}

/// Pane 3 — one message, whole (spec §8).
///
/// Separate from [`list_messages`] on purpose. Pane 2 draws a hundred rows and
/// needs a header for each; pane 3 draws one message and needs everything about
/// it. Folding the payload into every row would put a plan body behind every
/// list repaint.
#[tauri::command]
async fn get_message(
    store: tauri::State<'_, SharedStore>,
    message_id: String,
) -> Result<Option<MessageDetail>, String> {
    with_events_async(store.inner().clone(), move |events, now| {
        detail::build_detail(events, &message_id, now)
    })
    .await
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
        let guard = store
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
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

fn start_services(
    handle: tauri::AppHandle,
    store: SharedStore,
    waiters: Arc<AckWaiters>,
    pending: Arc<Pending>,
    lifecycle: Arc<ServiceLifecycle>,
) {
    if !lifecycle.begin() {
        return;
    }

    let (body_jobs, body_queue) = tokio::sync::mpsc::unbounded_channel();
    tauri::async_runtime::spawn(catch_up(store.clone()));
    tauri::async_runtime::spawn(capture::run(store.clone(), body_queue, pending.clone()));
    tauri::async_runtime::spawn(async move {
        let notify = handle.clone();
        let sink = InboxSink::new(
            store,
            waiters,
            Queue::new(body_jobs, pending),
            Box::new(move || {
                if let Err(error) = notify.emit(CHANGED_EVENT, ()) {
                    log::warn!("could not notify the window of new events: {error}");
                }
            }),
        );
        subscribe_loop(&sink, &ConnectionStatus::default()).await;
    });
}

#[tauri::command]
fn get_connection_settings() -> Result<settings::ConnectionSettings, String> {
    let dir = hitl_transport::paths::hitl_dir()?;
    settings::load_public_at(&dir, cfg!(target_os = "android"))
}

#[tauri::command]
fn save_connection_settings(
    app: tauri::AppHandle,
    store: tauri::State<'_, SharedStore>,
    waiters: tauri::State<'_, Arc<AckWaiters>>,
    pending: tauri::State<'_, Arc<Pending>>,
    lifecycle: tauri::State<'_, Arc<ServiceLifecycle>>,
    settings_lock: tauri::State<'_, Mutex<()>>,
    topic_id: String,
    encryption_key: String,
) -> Result<(), String> {
    if !cfg!(target_os = "android") {
        return Err("Connection settings can only be changed in the Android app.".to_string());
    }
    let _guard = settings_lock
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let dir = hitl_transport::paths::hitl_dir()?;
    settings::save_at(
        &dir,
        settings::ConnectionInput {
            topic_id,
            encryption_key,
        },
    )?;
    start_services(
        app,
        store.inner().clone(),
        waiters.inner().clone(),
        pending.inner().clone(),
        lifecycle.inner().clone(),
    );
    Ok(())
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
#[cfg(target_os = "windows")]
const WEBVIEW_FLAGS: &str = concat!(
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,",
    "CalculateNativeWinOcclusion ",
    "--disable-background-timer-throttling ",
    "--disable-renderer-backgrounding ",
    "--disable-backgrounding-occluded-windows",
);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_logging();
    log::info!("HITL Inbox {} starting", env!("CARGO_PKG_VERSION"));

    #[cfg(target_os = "windows")]
    {
        // Before anything can construct WebView2, and appended so externally
        // supplied flags retain precedence.
        let flags = match std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") {
            Ok(existing) if !existing.trim().is_empty() => format!("{existing} {WEBVIEW_FLAGS}"),
            _ => WEBVIEW_FLAGS.to_string(),
        };
        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", &flags);
        log::info!("webview flags: {flags}");
    }

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            list_sessions,
            list_messages,
            get_message,
            get_body,
            reply::submit_answer,
            reply::dismiss_notification,
            reply::dismiss_notifications,
            reply::restore_notifications,
            reply::submit_plan_review,
            reply::save_review_draft,
            reply::load_review_draft,
            reply::clear_review_draft,
            get_connection_settings,
            save_connection_settings
        ])
        .setup(|app| {
            #[cfg(target_os = "android")]
            {
                let dir = app
                    .path()
                    .app_data_dir()
                    .map_err(|error| error.to_string())?;
                hitl_transport::paths::set_hitl_dir(dir).map_err(|existing| {
                    format!(
                        "HITL state directory was already set to {}",
                        existing.display()
                    )
                })?;
            }

            let path = database_path()?;
            let store =
                Arc::new(Mutex::new(Store::open(&path).map_err(|error| {
                    format!("could not open {}: {error}", path.display())
                })?));
            log::info!("inbox database at {}", path.display());

            let waiters = Arc::new(AckWaiters::default());
            let pending = Arc::new(Pending::default());
            let lifecycle = Arc::new(ServiceLifecycle::default());
            app.manage(store.clone());
            app.manage(waiters.clone());
            app.manage(pending.clone());
            app.manage(lifecycle.clone());
            app.manage(Mutex::new(()));
            // Nothing in the Inbox cancels a review; this state only lets the
            // existing review submission settle.
            app.manage(OutstandingReviews::default());

            let mobile_needs_setup = if cfg!(target_os = "android") {
                match settings::load_public_at(&hitl_transport::paths::hitl_dir()?, true) {
                    Ok(settings) => !settings.configured,
                    Err(error) => {
                        // The WebView command reports the same error in the
                        // setup dialog. Keep the shell alive so it can do so.
                        log::warn!("mobile connection requires repair: {error}");
                        true
                    }
                }
            } else {
                false
            };
            if !mobile_needs_setup {
                start_services(app.handle().clone(), store, waiters, pending, lifecycle);
            }

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
    fn service_lifecycle_allows_exactly_one_concurrent_start() {
        let lifecycle = Arc::new(ServiceLifecycle::default());
        let workers: Vec<_> = (0..16)
            .map(|_| {
                let lifecycle = lifecycle.clone();
                std::thread::spawn(move || lifecycle.begin())
            })
            .collect();

        let winners = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .filter(|started| *started)
            .count();
        assert_eq!(winners, 1);
        assert!(!lifecycle.begin());
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

    #[tokio::test(flavor = "current_thread")]
    async fn view_projection_work_runs_off_the_command_calling_thread() {
        let store: SharedStore = Arc::new(Mutex::new(Store::open_in_memory().unwrap()));
        let calling_thread = std::thread::current().id();

        let projection_thread = with_events_async(store, |_, _| std::thread::current().id())
            .await
            .unwrap();

        assert_ne!(projection_thread, calling_thread);
    }
}
