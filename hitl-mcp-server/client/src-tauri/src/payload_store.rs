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

/// Events received while the notifications webview is registering listeners.
/// Switching to live delivery and draining the queue share the same lock.
pub struct NotificationStartup(pub Mutex<Option<Vec<serde_json::Value>>>);

impl Default for NotificationStartup {
    fn default() -> Self { Self(Mutex::new(Some(Vec::new()))) }
}

impl NotificationStartup {
    pub fn queue(&self, event: &str, payload: &serde_json::Value) -> bool {
        let mut pending = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(events) = pending.as_mut() {
            events.push(serde_json::json!({"event": event, "payload": payload}));
            true
        } else { false }
    }

    pub fn ready(&self) -> Vec<serde_json::Value> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).take().unwrap_or_default()
    }

    pub fn reset(&self) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(Vec::new());
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
    fn notification_startup_drains_updates_in_order_then_switches_to_live() {
        let startup = NotificationStartup::default();
        let first = serde_json::json!({"revision": 1});
        let latest = serde_json::json!({"revision": 2});
        assert!(startup.queue("add-notification", &first));
        assert!(startup.queue("add-notification", &latest));
        assert!(startup.queue("remove-notification", &serde_json::json!("work")));
        assert_eq!(startup.ready(), vec![
            serde_json::json!({"event":"add-notification", "payload":first}),
            serde_json::json!({"event":"add-notification", "payload":latest}),
            serde_json::json!({"event":"remove-notification", "payload":"work"}),
        ]);
        assert!(!startup.queue("add-notification", &latest));
        assert!(startup.ready().is_empty());
        startup.reset();
        assert!(startup.queue("add-notification", &latest));
        assert_eq!(startup.ready(), vec![serde_json::json!({"event":"add-notification", "payload":latest})]);
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
