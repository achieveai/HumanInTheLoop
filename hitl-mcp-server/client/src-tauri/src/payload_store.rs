use std::collections::HashMap;
use std::sync::Mutex;

use tauri::{AppHandle, Manager, State};

/// Per-window payload handoff.
///
/// Windows used to receive their whole message URL-encoded into the query
/// string (`index.html?question=<encoded>`), which does not survive a 100 KB
/// plan and leaks content into anything that logs URLs. The window is now
/// opened with a bare page and pulls its payload once, by label, over IPC.
///
/// Entries live for the lifetime of their window, not for a single read. A
/// reload — a refresh, a devtools reload, a WebView2 renderer crash and
/// recover — re-runs the frontend from scratch, and a read-once store answered
/// the second request with "no payload staged", turning a live dialog into a
/// permanently blank window with its question already consumed. The window's
/// `Destroyed` event is what evicts.
#[derive(Default)]
pub struct PayloadStore(pub Mutex<HashMap<String, String>>);

/// Current notification presentation for the lifetime of its native window.
/// Keep state even after ready, so renderer reloads cannot lose live arrivals.
#[derive(Default)]
pub struct NotificationStartup(Mutex<NotificationState>);

#[derive(Default)]
struct NotificationState {
    ready: bool,
    sequence: u64,
    entries: Vec<(String, Option<serde_json::Value>, bool)>,
}

impl NotificationStartup {
    /// Record before emitting. The returned sequence lets a reloading renderer
    /// ignore buffered events already represented in its restored snapshot.
    pub fn record(&self, event: &str, payload: &serde_json::Value) -> (bool, serde_json::Value) {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        state.sequence += 1;
        let entry = serde_json::json!({"event":event,"payload":payload,"sequence":state.sequence});
        let id = if event == "remove-notification" { payload.as_str() }
            else if payload["type"] == "work_update" { payload["workId"].as_str() }
            else { payload["messageId"].as_str() };
        if let Some(id) = id {
            let index = state.entries.iter().position(|(key, _, _)| key == id);
            if event == "remove-notification" {
                if let Some(index) = index { state.entries[index].2 = false; }
                else { state.entries.push((id.to_string(), None, false)); }
            } else if event == "add-notification" {
                let work = payload["type"] == "work_update";
                let visible = !work || payload["alert"] == true;
                if let Some(index) = index {
                    let (_, previous, was_visible) = &mut state.entries[index];
                    if work && previous.as_ref().and_then(|p| p["revision"].as_u64()).unwrap_or(0)
                        >= payload["revision"].as_u64().unwrap_or(0) {
                        return (!state.ready, entry);
                    }
                    *previous = Some(payload.clone());
                    *was_visible |= visible;
                } else { state.entries.push((id.to_string(), Some(payload.clone()), visible)); }
            }
        }
        (!state.ready, entry)
    }

    pub fn queue(&self, event: &str, payload: &serde_json::Value) -> bool {
        self.record(event, payload).0
    }

    pub fn ready(&self) -> Vec<serde_json::Value> {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        state.ready = true;
        // Include a cursor even when all ordinary cards were dismissed.
        let mut result = vec![serde_json::json!({"event":"notification-snapshot", "sequence":state.sequence})];
        for (id, payload, visible) in &state.entries {
            if let Some(mut payload) = payload.clone() {
                if payload["type"] == "work_update" {
                    // Replay visibility, not alert intent: no sound is triggered by IPC.
                    payload["alert"] = serde_json::json!(visible);
                } else if !visible { continue; }
                result.push(serde_json::json!({"event":"add-notification","payload":payload,"sequence":state.sequence}));
            } else {
                result.push(serde_json::json!({"event":"remove-notification","payload":id,"sequence":state.sequence}));
            }
        }
        result
    }

    pub fn reset(&self) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = NotificationState::default();
    }
}

/// The frontend registers its live listener before draining startup events.
#[tauri::command]
pub fn notifications_ready(window: tauri::WebviewWindow, state: State<NotificationStartup>) -> Result<Vec<serde_json::Value>, String> {
    if window.label() != "notifications" { return Err("Only the notifications window can receive its queue".into()); }
    Ok(state.ready())
}

impl PayloadStore {
    /// Stage a JSON payload for the window with this label.
    pub fn insert(&self, label: &str, json: String) {
        if let Ok(mut map) = self.0.lock() {
            map.insert(label.to_string(), json);
        }
    }

    /// Read the payload staged for this label, leaving it in place so a reload
    /// can ask again.
    pub fn get(&self, label: &str) -> Option<String> {
        self.0.lock().ok()?.get(label).cloned()
    }

    /// Remove and return the payload staged for this label, if any.
    ///
    /// For the two cases where no window will ever read it: the window failed
    /// to build, or it has been destroyed.
    pub fn take(&self, label: &str) -> Option<String> {
        self.0.lock().ok()?.remove(label)
    }
}

/// Stage a payload before creating the window that will read it.
pub fn put(app: &AppHandle, label: &str, json: String) {
    app.state::<PayloadStore>().insert(label, json);
}

/// Drop the payload for a window that no longer exists.
///
/// Without this the store is append-only for the process lifetime, and a
/// long-running client accumulates every plan and question it has ever shown.
pub fn evict(app: &AppHandle, label: &str) {
    if app.state::<PayloadStore>().take(label).is_some() {
        log::debug!("Evicted staged payload for destroyed window {label}");
    }
}

/// Tauri command: hand the calling window its staged payload.
///
/// Non-consuming on purpose — see `PayloadStore`.
#[tauri::command]
pub fn take_window_payload(
    window: tauri::WebviewWindow,
    state: State<PayloadStore>,
) -> Result<String, String> {
    let label = window.label();
    state
        .get(label)
        .ok_or_else(|| format!("No payload staged for window '{label}'"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notification_reload_keeps_latest_and_dismissal_during_listener_gap() {
        let startup = NotificationStartup::default();
        let work = |revision, alert| serde_json::json!({"type":"work_update", "workId":"work", "revision":revision,"alert":alert});
        startup.queue("add-notification", &work(1, true));
        startup.ready();
        // The renderer has gone away. Native reception must still retain state.
        assert!(!startup.queue("add-notification", &work(2, false)));
        let restored = startup.ready();
        assert_eq!(restored[1]["payload"]["revision"], 2);
        assert_eq!(restored[1]["payload"]["alert"], true);
        startup.queue("remove-notification", &serde_json::json!("work"));
        startup.queue("add-notification", &work(3, false));
        let restored = startup.ready();
        assert_eq!(restored[1]["payload"]["revision"], 3);
        assert_eq!(restored[1]["payload"]["alert"], false);
        startup.queue("add-notification", &work(2, true));
        assert_eq!(startup.ready()[1]["payload"], restored[1]["payload"]);
        startup.queue("add-notification", &work(4, true));
        assert_eq!(startup.ready()[1]["payload"]["alert"], true);
        startup.reset();
        assert_eq!(startup.ready().len(), 1);
    }

    #[test]
    fn notification_startup_coalesces_before_ready_and_preserves_other_cards() {
        let startup = NotificationStartup::default();
        let first = serde_json::json!({"type":"work_update", "workId":"work", "revision":1,"alert":true});
        let latest = serde_json::json!({"type":"work_update", "workId":"work", "revision":2,"alert":false});
        assert!(startup.queue("add-notification", &first));
        assert!(startup.queue("add-notification", &latest));
        startup.queue("add-notification", &serde_json::json!({"messageId":"other"}));
        let ready = startup.ready();
        assert_eq!(ready.len(), 3);
        assert_eq!(ready[0]["sequence"], 3);
        assert_eq!(ready[1]["payload"]["revision"], 2);
        assert_eq!(ready[1]["payload"]["alert"], true);
        let (queued, removal) = startup.record("remove-notification", &serde_json::json!("work"));
        assert!(!queued);
        assert_eq!(removal["sequence"], 4);
        let ready = startup.ready();
        assert_eq!(ready[0]["sequence"], 4);
        assert_eq!(ready[1]["payload"]["alert"], false);
        assert_eq!(ready[2]["payload"]["messageId"], "other");
        startup.queue("remove-notification", &serde_json::json!("other"));
        assert_eq!(startup.ready().len(), 2);
        startup.reset();
        assert!(startup.queue("add-notification", &first));
        assert_eq!(startup.ready()[0]["sequence"], 1);
    }

    #[test]
    fn a_reload_can_read_the_same_payload_again() {
        // A refresh, a devtools reload, or a WebView2 renderer crash re-runs
        // the frontend from scratch. Consuming on read left the second attempt
        // with a blank window and the question already gone.
        let store = PayloadStore::default();
        store.insert("dialog-abc12345", "{\"type\":\"question\"}".to_string());

        assert_eq!(store.get("dialog-abc12345").as_deref(), Some("{\"type\":\"question\"}"));
        assert_eq!(store.get("dialog-abc12345").as_deref(), Some("{\"type\":\"question\"}"));
    }

    #[test]
    fn take_returns_the_staged_payload_exactly_once() {
        let store = PayloadStore::default();
        store.insert("review-abc12345", "{\"type\":\"plan_review\"}".to_string());

        assert_eq!(
            store.take("review-abc12345").as_deref(),
            Some("{\"type\":\"plan_review\"}")
        );
        assert_eq!(store.take("review-abc12345"), None);
    }

    #[test]
    fn a_destroyed_window_leaves_nothing_behind() {
        let store = PayloadStore::default();
        store.insert("review-abc12345", "plan".to_string());
        assert!(store.get("review-abc12345").is_some());

        store.take("review-abc12345");

        assert_eq!(store.get("review-abc12345"), None);
        assert!(store.0.lock().unwrap().is_empty(), "the store must not grow unboundedly");
    }

    #[test]
    fn get_is_keyed_by_label_so_windows_cannot_read_each_others_payloads() {
        let store = PayloadStore::default();
        store.insert("dialog-11111111", "question".to_string());
        store.insert("review-22222222", "plan".to_string());

        assert_eq!(store.get("review-22222222").as_deref(), Some("plan"));
        assert_eq!(store.get("dialog-11111111").as_deref(), Some("question"));
        assert_eq!(store.get("dialog-33333333"), None);
    }

    #[test]
    fn take_is_keyed_by_label_so_windows_cannot_read_each_others_payloads() {
        let store = PayloadStore::default();
        store.insert("dialog-11111111", "question".to_string());
        store.insert("review-22222222", "plan".to_string());

        assert_eq!(store.take("review-22222222").as_deref(), Some("plan"));
        assert_eq!(store.take("dialog-11111111").as_deref(), Some("question"));
    }

    #[test]
    fn take_returns_none_for_an_unknown_label() {
        assert_eq!(PayloadStore::default().take("review-deadbeef"), None);
    }

    #[test]
    fn insert_replaces_a_stale_payload_for_the_same_label() {
        let store = PayloadStore::default();
        store.insert("review-abc12345", "old".to_string());
        store.insert("review-abc12345", "new".to_string());

        assert_eq!(store.take("review-abc12345").as_deref(), Some("new"));
    }
}
