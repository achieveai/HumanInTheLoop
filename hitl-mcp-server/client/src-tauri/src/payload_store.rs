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
/// Entries are removed on read: a window asks exactly once, at startup.
#[derive(Default)]
pub struct PayloadStore(pub Mutex<HashMap<String, String>>);

impl PayloadStore {
    /// Stage a JSON payload for the window with this label.
    pub fn insert(&self, label: &str, json: String) {
        if let Ok(mut map) = self.0.lock() {
            map.insert(label.to_string(), json);
        }
    }

    /// Remove and return the payload staged for this label, if any.
    pub fn take(&self, label: &str) -> Option<String> {
        self.0.lock().ok()?.remove(label)
    }
}

/// Stage a payload before creating the window that will read it.
// Called by the window-creation paths (show_question / show_review), which land
// with the review window itself.
#[allow(dead_code)]
pub fn put(app: &AppHandle, label: &str, json: String) {
    app.state::<PayloadStore>().insert(label, json);
}

/// Tauri command: hand the calling window its staged payload, once.
#[tauri::command]
pub fn take_window_payload(
    window: tauri::WebviewWindow,
    state: State<PayloadStore>,
) -> Result<String, String> {
    let label = window.label();
    state
        .take(label)
        .ok_or_else(|| format!("No payload staged for window '{label}'"))
}

#[cfg(test)]
mod tests {
    use super::*;

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
