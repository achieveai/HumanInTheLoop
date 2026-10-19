//! Desktop notifications: a toast for a new question, plan review, handoff or
//! agent notification, so a message is seen while the Inbox sits behind other
//! windows.
//!
//! The decisions live here as plain functions so they can be tested without a
//! window: which events toast, what they say, and when a burst becomes one
//! summary. `lib.rs` only shows what [`Toaster::decide`] returns.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Older than this, an event is history arriving late (a reconnect, a cache
/// replay after a long time away), not news.
pub const FRESH_SECS: u64 = 120;

/// More toasts than this inside [`BURST_SECS`] become one summary.
const BURST_LIMIT: usize = 3;
const BURST_SECS: u64 = 10;

/// What the body is cut to: one line in a toast.
const BODY_CHARS: usize = 140;

/// How many recent senders to remember. A sender's name arrives in its own
/// event just after the message it names, so only the last few matter.
const SENDERS_KEPT: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Toast {
    /// Who sent it: the session's name once known, else the repo, else "An agent".
    pub who: String,
    /// What happened: "asks", "finished", ...
    pub what: String,
    pub body: String,
    /// The message whose sender would name this toast; `None` for a summary.
    pub message_id: Option<String>,
}

impl Toast {
    pub fn title(&self) -> String {
        if self.who.is_empty() {
            self.what.clone()
        } else {
            format!("{} {}", self.who, self.what)
        }
    }
}

/// The toast for one event, or `None` when it should stay quiet.
///
/// `event_time` and `now` are seconds (ntfy's clock); `payload` is the
/// decrypted message.
pub fn toast_for(payload: &str, event_time: u64, now: u64) -> Option<Toast> {
    if now.saturating_sub(event_time) > FRESH_SECS {
        return None;
    }
    let value: Value = serde_json::from_str(payload).ok()?;
    let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty());
    let (verb, line) = match value.get("type")?.as_str()? {
        "question" => {
            let first = value.get("questions").and_then(Value::as_array).and_then(|q| q.first())
                .and_then(|q| q.get("question")).and_then(Value::as_str);
            ("asks", text("question").or(first).unwrap_or("A question is waiting"))
        }
        "plan_review" => ("has a plan to review", text("summary").or(text("displayPath")).unwrap_or("A plan is waiting")),
        "handoff" => ("finished", text("title").or(text("summary")).unwrap_or("Work handed off")),
        "notification" => ("says", text("title").or(text("body")).unwrap_or("New notification")),
        _ => return None,
    };
    // A plan review carries its sender inline; everything else is named by a
    // `sender_identity` event that follows it, so it keeps its id to wait for one.
    if let Some(name) = value.get("sender").and_then(name_of) {
        return Some(Toast { who: name, what: verb.to_string(), body: one_line(line), message_id: None });
    }
    let who = value.get("repo").and_then(|repo| repo.get("name")).and_then(Value::as_str)
        .filter(|s| !s.is_empty()).unwrap_or("An agent");
    Some(Toast {
        who: who.to_string(),
        what: verb.to_string(),
        body: one_line(line),
        message_id: text("messageId").map(str::to_string),
    })
}

/// What an agent called its session, else its sender label.
fn name_of(sender: &Value) -> Option<String> {
    let text = |key: &str| sender.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty());
    text("sessionName").or(text("label")).map(str::to_string)
}

/// The name a `sender_identity` event gives the message it decorates: what the
/// agent called its session, else its label. `(forMessageId, name)`.
pub fn sender_name(payload: &str) -> Option<(String, String)> {
    let value: Value = serde_json::from_str(payload).ok()?;
    if value.get("type")?.as_str()? != "sender_identity" {
        return None;
    }
    let id = value.get("forMessageId")?.as_str().filter(|s| !s.is_empty())?;
    Some((id.to_string(), name_of(value.get("sender")?)?))
}

fn one_line(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= BODY_CHARS {
        return flat;
    }
    let cut: String = flat.chars().take(BODY_CHARS - 1).collect();
    format!("{}…", cut.trim_end())
}

/// Turns toasts on and off, and keeps a burst from becoming a wall of them.
pub struct Toaster {
    enabled: AtomicBool,
    burst: Mutex<Burst>,
    senders: Mutex<VecDeque<(String, String)>>,
}

/// When the last few toasts and the last summary were shown.
#[derive(Default)]
struct Burst {
    shown: VecDeque<u64>,
    summary_at: Option<u64>,
}

impl Toaster {
    pub fn new(enabled: bool) -> Self {
        Self {
            enabled: AtomicBool::new(enabled),
            burst: Mutex::default(),
            senders: Mutex::new(VecDeque::new()),
        }
    }

    /// Remember the sender a `sender_identity` event names; anything else is ignored.
    pub fn note_sender(&self, payload: &str) {
        if let Some(entry) = sender_name(payload) {
            let mut senders = self.senders.lock().unwrap_or_else(|p| p.into_inner());
            if senders.len() == SENDERS_KEPT {
                senders.pop_front();
            }
            senders.push_back(entry);
        }
    }

    /// The name of the sender of `message_id`, once its identity has arrived.
    pub fn sender_of(&self, message_id: &str) -> Option<String> {
        let senders = self.senders.lock().unwrap_or_else(|p| p.into_inner());
        senders.iter().rev().find(|(id, _)| id == message_id).map(|(_, name)| name.clone())
    }

    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::SeqCst);
    }

    /// What to show for one new event: its own toast, one summary once a burst
    /// passes [`BURST_LIMIT`], or nothing. `focused` is whether the Inbox window
    /// has focus; the reader is already looking then.
    pub fn decide(&self, payload: &str, event_time: u64, now: u64, focused: bool) -> Option<Toast> {
        if !self.enabled() || focused {
            return None;
        }
        let toast = toast_for(payload, event_time, now)?;
        let mut burst = self.burst.lock().unwrap_or_else(|p| p.into_inner());
        while burst.shown.front().is_some_and(|&t| now.saturating_sub(t) >= BURST_SECS) {
            burst.shown.pop_front();
        }
        if burst.shown.len() < BURST_LIMIT {
            burst.shown.push_back(now);
            return Some(toast);
        }
        // Past the limit: one summary per window, so steady traffic still
        // says something every [`BURST_SECS`] instead of going silent.
        if burst.summary_at.is_some_and(|t| now.saturating_sub(t) < BURST_SECS) {
            return None;
        }
        burst.summary_at = Some(now);
        Some(Toast {
            who: String::new(),
            what: "More new messages".to_string(),
            body: "Several agents need you. Open the Inbox to see them all.".to_string(),
            message_id: None,
        })
    }
}

/// The Inbox's own preferences on this machine, beside the HITL config.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxPrefs {
    #[serde(default = "on")]
    pub notifications: bool,
}

fn on() -> bool {
    true
}

impl Default for InboxPrefs {
    fn default() -> Self {
        Self { notifications: true }
    }
}

pub fn prefs_path(dir: &Path) -> PathBuf {
    dir.join("inbox-settings.json")
}

/// Missing or unreadable preferences read as the defaults: notifications on.
pub fn load_prefs(dir: &Path) -> InboxPrefs {
    std::fs::read_to_string(prefs_path(dir))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// Keeps any other key already in the file.
pub fn save_prefs(dir: &Path, prefs: &InboxPrefs) -> Result<(), String> {
    let path = prefs_path(dir);
    let mut value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| Value::Object(Default::default()));
    value["notifications"] = Value::Bool(prefs.notifications);
    std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let text = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())? + "\n";
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("could not write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("could not save {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_800_000_000;

    fn question(text: &str) -> String {
        serde_json::json!({ "type": "question", "messageId": "q1", "timestamp": 1, "context": "c",
            "question": text, "options": [], "allowMultiple": false, "allowOther": true,
            "repo": { "name": "Hitl_MCP", "branch": "master" } }).to_string()
    }

    #[test]
    fn questions_reviews_handoffs_and_notifications_toast() {
        assert_eq!(toast_for(&question("Red or blue?"), NOW, NOW), Some(Toast {
            who: "Hitl_MCP".into(), what: "asks".into(), body: "Red or blue?".into(), message_id: Some("q1".into()),
        }));
        // A plan review names itself: its sender rides inline, so it waits for no one.
        let review = r#"{"type":"plan_review","messageId":"r","summary":"Ship 2.17","displayPath":"docs/plan.md",
            "sender":{"label":"Hitl_MCP · master · a3f2","source":"session","sessionName":"Release prep"}}"#;
        assert_eq!(toast_for(review, NOW, NOW), Some(Toast {
            who: "Release prep".into(), what: "has a plan to review".into(), body: "Ship 2.17".into(), message_id: None,
        }));
        let unnamed = r#"{"type":"plan_review","messageId":"r","summary":"","displayPath":"docs/plan.md"}"#;
        let toast = toast_for(unnamed, NOW, NOW).unwrap();
        assert_eq!((toast.title(), toast.body.as_str()), ("An agent has a plan to review".to_string(), "docs/plan.md"));
        let handoff = r#"{"type":"handoff","title":"Inbox fix merged","summary":"x"}"#;
        let toast = toast_for(handoff, NOW, NOW).unwrap();
        assert_eq!((toast.title(), toast.body.as_str()), ("An agent finished".to_string(), "Inbox fix merged"));
        let note = r#"{"type":"notification","title":"Build done","body":"ok"}"#;
        assert_eq!(toast_for(note, NOW, NOW).unwrap().body, "Build done");
        // A batch question names its first sub-question.
        let batch = r#"{"type":"question","question":"","questions":[{"question":"Which tag?"}]}"#;
        assert_eq!(toast_for(batch, NOW, NOW).unwrap().body, "Which tag?");
    }

    #[test]
    fn everything_else_stays_quiet() {
        for payload in [
            r#"{"type":"work_update","title":"Progress"}"#,
            r#"{"type":"answer","questionId":"q"}"#,
            r#"{"type":"agent_message","text":"hi"}"#,
            r#"{"type":"dismiss_notification"}"#,
            r#"{"type":"sender_identity"}"#,
            "not json",
            r#"{"no":"type"}"#,
        ] {
            assert_eq!(toast_for(payload, NOW, NOW), None, "{payload}");
        }
    }

    #[test]
    fn old_events_arriving_late_stay_quiet() {
        assert!(toast_for(&question("q"), NOW - FRESH_SECS, NOW).is_some());
        assert!(toast_for(&question("q"), NOW - FRESH_SECS - 1, NOW).is_none());
        // A clock slightly ahead of ours is still news.
        assert!(toast_for(&question("q"), NOW + 5, NOW).is_some());
    }

    #[test]
    fn the_body_is_one_short_line() {
        let long = "word ".repeat(100);
        let body = toast_for(&question(&format!("line one\n\n  {long}")), NOW, NOW).unwrap().body;
        assert!(!body.contains('\n'));
        assert!(body.chars().count() <= BODY_CHARS);
        assert!(body.starts_with("line one word") && body.ends_with('…'));
    }

    #[test]
    fn off_or_focused_shows_nothing() {
        let toaster = Toaster::new(true);
        assert!(toaster.decide(&question("q"), NOW, NOW, true).is_none());
        toaster.set_enabled(false);
        assert!(toaster.decide(&question("q"), NOW, NOW, false).is_none());
        toaster.set_enabled(true);
        assert!(toaster.decide(&question("q"), NOW, NOW, false).is_some());
    }

    #[test]
    fn a_burst_becomes_one_summary_then_quiet_until_it_passes() {
        let toaster = Toaster::new(true);
        let shown: Vec<_> = (0..6).map(|i| toaster.decide(&question("q"), NOW, NOW + i, false)).collect();
        assert!(shown[..3].iter().all(|t| t.as_ref().is_some_and(|t| t.title() == "Hitl_MCP asks")));
        let summary = shown[3].as_ref().unwrap();
        assert_eq!((summary.title(), summary.message_id.as_ref()), ("More new messages".to_string(), None));
        assert!(shown[4].is_none() && shown[5].is_none());
        // Ten quiet seconds later, toasts come one by one again.
        assert_eq!(toaster.decide(&question("q"), NOW + 30, NOW + 30, false).unwrap().title(), "Hitl_MCP asks");
    }

    #[test]
    fn steady_traffic_gets_a_summary_every_ten_seconds_not_silence() {
        let toaster = Toaster::new(true);
        let titles: Vec<_> = (0..30)
            .map(|i| toaster.decide(&question("q"), NOW + i, NOW + i, false).map(|t| t.title()))
            .collect();
        let summaries = titles.iter().filter(|t| t.as_deref() == Some("More new messages")).count();
        // Three a window plus one summary: never silent, never a wall.
        assert_eq!(summaries, 3, "{titles:?}");
        assert_eq!(titles.iter().flatten().count(), 3 * (BURST_LIMIT + 1), "{titles:?}");
    }

    #[test]
    fn the_sender_names_its_message_by_session_name_then_label() {
        let toaster = Toaster::new(true);
        assert_eq!(toaster.sender_of("q1"), None);
        toaster.note_sender(r#"{"type":"sender_identity","forMessageId":"q1","forType":"question",
            "sender":{"label":"Hitl_MCP · master · a3f2","source":"session","sessionName":"Inbox toasts"}}"#);
        toaster.note_sender(r#"{"type":"sender_identity","forMessageId":"n1","forType":"notification",
            "sender":{"label":"Hitl_MCP · master · a3f2","source":"session"}}"#);
        toaster.note_sender(&question("not a sender"));
        assert_eq!(toaster.sender_of("q1").as_deref(), Some("Inbox toasts"));
        assert_eq!(toaster.sender_of("n1").as_deref(), Some("Hitl_MCP · master · a3f2"));

        // Only the recent ones are kept.
        for i in 0..SENDERS_KEPT {
            toaster.note_sender(&format!(r#"{{"type":"sender_identity","forMessageId":"m{i}","sender":{{"label":"L"}}}}"#));
        }
        assert_eq!(toaster.sender_of("q1"), None);
        assert_eq!(toaster.sender_of("m0").as_deref(), Some("L"));
    }

    #[test]
    fn preferences_default_to_on_survive_a_restart_and_keep_other_keys() {
        let dir = std::env::temp_dir().join(format!("hitl-inbox-prefs-{}", uuid::Uuid::new_v4()));
        assert_eq!(load_prefs(&dir), InboxPrefs { notifications: true });

        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(prefs_path(&dir), r#"{"theme":"dark"}"#).unwrap();
        save_prefs(&dir, &InboxPrefs { notifications: false }).unwrap();
        assert_eq!(load_prefs(&dir), InboxPrefs { notifications: false });
        let saved: Value = serde_json::from_str(&std::fs::read_to_string(prefs_path(&dir)).unwrap()).unwrap();
        assert_eq!(saved["theme"], "dark");

        std::fs::write(prefs_path(&dir), "{ broken").unwrap();
        assert_eq!(load_prefs(&dir), InboxPrefs { notifications: true });
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
