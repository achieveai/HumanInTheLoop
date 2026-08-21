// A release build must not drag a console window along behind it; a debug
// build must keep stderr, because that is where `env_logger` writes and the
// whole of this binary's diagnostics with it.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backfill;
mod identity;
mod session;
mod sink;
mod view;

use std::sync::{Arc, Mutex};

use hitl_store::{Event, Store};
use hitl_transport::ntfy::subscribe::subscribe_loop;
use hitl_transport::status::ConnectionStatus;
use tauri::{Emitter, Manager};

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

    let home = dirs::home_dir().ok_or("could not determine the home directory")?;
    let dir = home.join(".hitl");
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    Ok(dir.join("inbox.db"))
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

fn main() {
    init_logging();
    log::info!("HITL Inbox {} starting", env!("CARGO_PKG_VERSION"));

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

    tauri::Builder::default()
        .manage(store)
        .invoke_handler(tauri::generate_handler![list_sessions, list_messages])
        .setup(|app| {
            let store = app.state::<SharedStore>().inner().clone();

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(catch_up(store.clone()));

            tauri::async_runtime::spawn(async move {
                let notify = handle.clone();
                let sink = InboxSink::new(
                    store,
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
