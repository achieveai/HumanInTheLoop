//! The Tauri client's half of the ntfy transport: windows, and the adapter
//! that lets `hitl-transport` raise them.
//!
//! Everything that is not a window lives in `hitl-transport` now. What is left
//! here is the desktop: window labels, window sizing, the payload each window
//! reads on load, and `TauriSink` — the `NtfySink` implementation that turns a
//! dispatched message into an open window.

use tauri::{AppHandle, Emitter, Manager};

use hitl_transport::config::load_config;
use hitl_transport::ntfy::dispatch::ReviewBodyError;
use hitl_transport::ntfy::http::download_and_decode;
use hitl_transport::ntfy::identity::SenderIdentityCacheState;
use hitl_transport::ntfy::review::{AckWaiters, OutstandingReviews};
use hitl_transport::ntfy::NtfySink;
use hitl_transport::status::ConnectionStatus;
use hitl_transport::types::{
    AnswerMessage, AttachmentRef, CancelReviewMessage, DismissNotificationMessage, HitlConfig,
    NotificationMessage, PlanReviewAckMessage, PlanReviewBody, PlanReviewMessage,
    PlanReviewResponseBody, PlanReviewResponseMessage, QuestionMessage, SenderIdentityMessage,
    SenderInfo,
};

use crate::payload_store;

// Re-exported so `main.rs` and `tray.rs` keep addressing these through
// `crate::ntfy::`, which is where they lived before the extraction.
pub use hitl_transport::ntfy::publish::{publish_answer, publish_dismiss_notification};
pub use hitl_transport::ntfy::review::PlanReviewSubmitResult;

/// Run work off the dispatch path so a slow network cannot stall the stream.
///
/// The `JoinHandle` is awaited rather than dropped: dropping it swallows a
/// panic, which is exactly how a dead subscription becomes invisible.
fn spawn_detached<F>(what: &'static str, work: F)
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    tauri::async_runtime::spawn(async move {
        if let Err(e) = tauri::async_runtime::spawn(work).await {
            log::error!("{} task did not finish: {}", what, e);
        }
    });
}

/// Start listening to ntfy, with this client's windows as the destination.
pub async fn subscribe_loop(app: AppHandle) {
    // The transport loads the config too. Loading it here as well is what lets
    // the sink answer `show_question` and `show_review`, both of which need
    // `sound_enabled` and `device_name`, without threading config through every
    // trait method.
    let config = match load_config() {
        Ok(c) => c,
        Err(e) => {
            log::error!("HITL config error: {}", e);
            return;
        }
    };

    let sink = TauriSink {
        app: app.clone(),
        config,
    };
    let status = app.state::<ConnectionStatus>();

    hitl_transport::ntfy::subscribe::subscribe_loop(&sink, &status).await;
}

/// Submit a review verdict, taking the two registries off the app handle.
///
/// The transport used to reach into Tauri state for these itself, which was the
/// one place the dependency ran backwards.
pub async fn submit_review_response(
    app: &AppHandle,
    review_id: String,
    snapshot_hash: String,
    verdict: String,
    body: PlanReviewResponseBody,
    encrypted: bool,
) -> Result<PlanReviewSubmitResult, String> {
    hitl_transport::ntfy::review::submit_review_response(
        &app.state::<AckWaiters>(),
        &app.state::<OutstandingReviews>(),
        review_id,
        snapshot_hash,
        verdict,
        body,
        encrypted,
    )
    .await
}

/// Turns a dispatched message into an open window.
///
/// One method per wire type, each calling exactly the window function that
/// message's dispatch arm used to call inline.
struct TauriSink {
    app: AppHandle,
    config: HitlConfig,
}

impl NtfySink for TauriSink {
    /// No-ops on purpose: the tray reads `ConnectionStatus` directly and the
    /// subscribe loop already updates it. These exist for hosts with no tray.
    fn on_connected(&self, _connected: bool) {}
    fn on_message(&self) {}

    fn on_question(&self, msg: &QuestionMessage, was_encrypted: bool) {
        show_question(&self.app, &self.config, msg, was_encrypted);
    }

    fn on_answer(&self, answer: &AnswerMessage) {
        if let Err(e) = self.app.emit("dismiss-question", answer) {
            log::error!("Failed to emit dismiss-question: {}", e);
        }

        // Only the dialog raised for THIS question. The label is derived, not
        // searched, precisely so an answer can never reach a review window: a
        // review holds minutes of typed comments and closing it would discard
        // every one of them.
        let label = window_label("dialog", &answer.question_id);
        if let Some(window) = self.app.get_webview_window(&label) {
            let _ = window.close();
        }
    }

    fn on_notification(&self, msg: &NotificationMessage, was_encrypted: bool) {
        show_notification(&self.app, &self.config, msg, was_encrypted);
    }

    fn on_dismiss_notification(&self, dismiss: &DismissNotificationMessage) {
        if let Some(win) = self.app.get_webview_window("notifications") {
            if let Err(e) = win.emit("remove-notification", &dismiss.notification_id) {
                log::error!("Failed to emit remove-notification: {}", e);
            }
        }
    }

    fn on_plan_review(
        &self,
        review: &PlanReviewMessage,
        was_encrypted: bool,
        attachment: Option<AttachmentRef>,
    ) {
        // Off the dispatch path. This is the one handler that makes a network
        // call — the attachment download — and dispatch is awaited inline
        // inside the stream loop, so awaiting it here would let one slow or
        // hung host stop every later message from being dispatched at all.
        let app = self.app.clone();
        let config = self.config.clone();
        let review = review.clone();
        spawn_detached("plan_review", async move {
            handle_plan_review(&app, &config, &review, was_encrypted, attachment).await;
        });
    }

    fn on_plan_review_response(&self, response: &PlanReviewResponseMessage) {
        self.app
            .state::<OutstandingReviews>()
            .settle(&response.review_id);
        notify_review_window(&self.app, &response.review_id, "review-superseded", response);
    }

    fn on_plan_review_ack(&self, ack: &PlanReviewAckMessage) {
        self.app.state::<AckWaiters>().deliver(ack.clone());
    }

    fn on_cancel_review(&self, cancel: &CancelReviewMessage) {
        self.app
            .state::<OutstandingReviews>()
            .settle(&cancel.review_id);
        notify_review_window(&self.app, &cancel.review_id, "review-cancelled", cancel);
    }

    fn on_sender_identity(&self, msg: &SenderIdentityMessage) {
        match decide_sender_identity_action(&msg.for_message_id, &msg.for_type, |label| {
            self.app.get_webview_window(label).is_some()
        }) {
            SenderIdentityAction::Emit(label) => {
                if let Some(window) = self.app.get_webview_window(&label) {
                    let event_payload = serde_json::json!({
                        "forMessageId": msg.for_message_id,
                        "sender": msg.sender,
                    });
                    if let Err(e) = window.emit("sender-identity", event_payload) {
                        log::error!("Failed to emit sender-identity to {}: {}", label, e);
                    }
                }
            }
            SenderIdentityAction::Cache => {
                self.app
                    .state::<SenderIdentityCacheState>()
                    .insert(&msg.for_message_id, msg.sender.clone());
            }
            SenderIdentityAction::Drop => log::debug!(
                "sender_identity dropped: empty forMessageId or unrecognized forType '{}'",
                msg.for_type
            ),
        }
    }

    fn is_view_open(&self, message_id: &str, kind: &str) -> bool {
        let label = match kind {
            "question" => window_label("dialog", message_id),
            "plan_review" => window_label("review", message_id),
            "notification" => "notifications".to_string(),
            _ => return false,
        };
        self.app.get_webview_window(&label).is_some()
    }

    fn on_unsupported_version(&self, message_id: &str, _msg_type: &str, version: u32, raw: &str) {
        show_upgrade_required(&self.app, message_id, version, raw);
    }
}

/// The first 8 characters of an id, on a char boundary, prefixed for the window
/// it addresses. Windows are found by label, so both the creating and the
/// closing side must derive it identically.
fn window_label(prefix: &str, id: &str) -> String {
    let cut = id
        .char_indices()
        .nth(8)
        .map(|(i, _)| i)
        .unwrap_or(id.len());
    format!("{}-{}", prefix, &id[..cut])
}

/// What dispatching a `sender_identity` message should do.
///
/// Stays on this side of the seam because `Emit` carries a *window label*, and
/// a label is a desktop concept the transport crate must not learn.
#[derive(Debug, PartialEq, Eq)]
enum SenderIdentityAction {
    /// Patch the window at this label — it is already open.
    Emit(String),
    /// No window open yet — remember it in `SenderIdentityCacheState` for when
    /// one is created.
    Cache,
    /// `forMessageId` was empty, or `forType` is neither "question" nor
    /// "notification" — dropped silently. Identity is decoration only; it
    /// never blocks, retries, or surfaces an error.
    Drop,
}

/// Decide what to do with a `sender_identity` message, without touching a real
/// window. Window lookups are I/O this crate has no test harness for (no
/// `tauri` "test" feature, no dev-dependencies) — this pure extraction is what
/// keeps the routing decision unit-testable, the same way `window_label` keeps
/// the rest of the window addressing testable.
///
/// `window_is_open` is called with the resolved label at most once, and only
/// when `for_message_id` and `for_type` are both valid — a real caller passes
/// `|label| app.get_webview_window(label).is_some()`.
fn decide_sender_identity_action(
    for_message_id: &str,
    for_type: &str,
    window_is_open: impl FnOnce(&str) -> bool,
) -> SenderIdentityAction {
    if for_message_id.is_empty() {
        return SenderIdentityAction::Drop;
    }

    let label = match for_type {
        "question" => window_label("dialog", for_message_id),
        "notification" => "notifications".to_string(),
        _ => return SenderIdentityAction::Drop,
    };

    if window_is_open(&label) {
        SenderIdentityAction::Emit(label)
    } else {
        SenderIdentityAction::Cache
    }
}

/// Merge a cached sender identity into a window's initial payload, if one was
/// found — the "cache-then-seed-later-window" path. A no-op when nothing was
/// cached, or when `payload` is not a JSON object (should never happen for the
/// two callers, but this must never panic).
fn merge_cached_sender(payload: &mut serde_json::Value, sender: Option<SenderInfo>) {
    let (Some(obj), Some(sender)) = (payload.as_object_mut(), sender) else {
        return;
    };
    obj.insert("sender".to_string(), serde_json::to_value(sender).unwrap_or_default());
}

/// Emit an event to the review window for `review_id`, if one is open.
///
/// Deliberately narrow: it can only ever address a `review-*` label, so nothing
/// routed through here can reach a `dialog-*` window and close it.
fn notify_review_window<T: serde::Serialize + Clone>(
    app: &AppHandle,
    review_id: &str,
    event: &str,
    payload: &T,
) {
    let label = window_label("review", review_id);
    let Some(window) = app.get_webview_window(&label) else {
        log::debug!("No open window '{}' for {}", label, event);
        return;
    };

    if let Err(e) = window.emit(event, payload.clone()) {
        log::error!("Failed to emit {} to {}: {}", event, label, e);
    }
}

/// Resolve a plan-review body and raise its window.
///
/// The window opens either way. A failure to decode is rendered as a named
/// state — "the plan expired, ask the agent to resend" — never as nothing.
async fn handle_plan_review(
    app: &AppHandle,
    config: &HitlConfig,
    review: &PlanReviewMessage,
    was_encrypted: bool,
    attachment: Option<AttachmentRef>,
) {
    let decoded =
        download_and_decode(review.body.as_ref(), attachment.as_ref(), config).await;

    if let Err(e) = &decoded {
        log::warn!(
            "plan_review {} body unavailable ({}): {}",
            review.message_id,
            e.kind(),
            e
        );
    }

    show_review(app, config, review, decoded, was_encrypted);
}

/// Build the JSON the review window reads via `take_window_payload`.
///
/// The wire message's `body` is a `PlanPayloadRef` describing where the payload
/// lives; the window has no use for that, so it is replaced in place with the
/// decoded `{content, diff}` — or with `null` plus a populated `_error`.
///
/// `_draft` is the read half of `save_review_draft`: there is no second command
/// for it, because the window already takes its payload exactly once and this
/// is that payload.
fn review_window_payload(
    review: &PlanReviewMessage,
    decoded: &Result<PlanReviewBody, ReviewBodyError>,
    was_encrypted: bool,
    device_name: &str,
    draft: Option<hitl_transport::drafts::ReviewDraft>,
) -> String {
    let mut payload = serde_json::to_value(review).unwrap_or_default();

    if let Some(obj) = payload.as_object_mut() {
        match decoded {
            Ok(body) => {
                obj.insert("body".into(), serde_json::to_value(body).unwrap_or_default());
                obj.insert("_error".into(), serde_json::Value::Null);
            }
            Err(e) => {
                obj.insert("body".into(), serde_json::Value::Null);
                obj.insert(
                    "_error".into(),
                    serde_json::json!({ "kind": e.kind(), "message": e.to_string() }),
                );
            }
        }
        obj.insert("_wasEncrypted".into(), serde_json::Value::Bool(was_encrypted));
        obj.insert("_device".into(), serde_json::Value::String(device_name.to_string()));
        obj.insert(
            "_draft".into(),
            draft
                .map(|d| serde_json::to_value(d).unwrap_or_default())
                .unwrap_or(serde_json::Value::Null),
        );
    }

    serde_json::to_string(&payload).unwrap_or_default()
}

/// Open a window that says this client is too old to read the message.
///
/// Only the two fields the panel renders are forwarded. A message from a
/// future protocol is precisely the case where this build's reading of the
/// rest cannot be trusted, so none of it is passed on.
fn show_upgrade_required(app: &AppHandle, message_id: &str, version: u32, raw: &str) {
    let label = window_label("review", message_id);

    if let Some(window) = app.get_webview_window(&label) {
        let _ = crate::window_utils::show_window_no_activate(&window);
        return;
    }

    let display_path = serde_json::from_str::<serde_json::Value>(raw)
        .ok()
        .and_then(|v| v.get("displayPath").and_then(|p| p.as_str()).map(String::from))
        .unwrap_or_default();

    let payload = serde_json::json!({
        "messageId": message_id,
        "protocolVersion": version,
        "displayPath": display_path,
    });
    payload_store::put(app, &label, payload.to_string());

    match build_review_window(app, &label, "Plan review — update required") {
        Ok(window) => {
            log::info!("Upgrade-required window created: {}", label);
            if let Err(e) = crate::window_utils::show_window_no_activate(&window) {
                log::error!("Failed to show upgrade window {}: {}", label, e);
            }
        }
        Err(e) => {
            app.state::<payload_store::PayloadStore>().take(&label);
            log::error!("Failed to create upgrade window: {}", e);
        }
    }
}

/// The size a review window would like to be, before the display gets a say.
const REVIEW_PREFERRED_SIZE: (f64, f64) = (1280.0, 900.0);
/// Below this the two-pane layout stops being usable.
const REVIEW_MIN_SIZE: (f64, f64) = (720.0, 520.0);

/// Shrink the preferred size to something that actually fits on screen.
///
/// E-9. 1280x900 is taller than a 1366x768 laptop display, and `.center()` then
/// pushes the overflow off both edges — including the verdict footer, which is
/// the bottom-most element by design (E-12), leaving a reviewer able to read
/// the plan and unable to act on it.
fn fit_to_work_area(preferred: (f64, f64), min: (f64, f64), available: (f64, f64)) -> (f64, f64) {
    let fit = |preferred: f64, min: f64, available: f64| {
        if available <= 0.0 {
            return preferred; // no usable monitor information
        }
        // A display smaller than the minimum takes the display: a window sized
        // past the screen edge is the very thing being fixed.
        preferred.min(available).max(min.min(available))
    };

    (
        fit(preferred.0, min.0, available.0),
        fit(preferred.1, min.1, available.1),
    )
}

fn review_window_size(app: &AppHandle) -> (f64, f64) {
    let Ok(Some(monitor)) = app.primary_monitor() else {
        log::debug!("No monitor information available; using the preferred window size");
        return REVIEW_PREFERRED_SIZE;
    };

    // The work area excludes the taskbar and dock, which is what the window
    // has to share the screen with.
    let area = monitor
        .work_area()
        .size
        .to_logical::<f64>(monitor.scale_factor());

    fit_to_work_area(REVIEW_PREFERRED_SIZE, REVIEW_MIN_SIZE, (area.width, area.height))
}

/// The review window shell, shared by a real review and the upgrade panel.
fn build_review_window(
    app: &AppHandle,
    label: &str,
    title: &str,
) -> tauri::Result<tauri::WebviewWindow> {
    let (width, height) = review_window_size(app);

    tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::App("review.html".into()))
        .title(title)
        .inner_size(width, height)
        .min_inner_size(REVIEW_MIN_SIZE.0, REVIEW_MIN_SIZE.1)
        .center()
        .resizable(true)
        // Decorated and not on top, both opposite to show_question: a review
        // window is worked in alongside an editor, and decorations are what give
        // the webview its find-in-page.
        .decorations(true)
        .always_on_top(false)
        .visible(false)
        .focused(false)
        .build()
}

/// Create and show the review window for a plan.
///
/// Deliberately unlike `show_question`: a review is read for minutes, not
/// glanced at, so it is large, decorated (which is what gives it find-in-page)
/// and explicitly NOT always-on-top.
fn show_review(
    app: &AppHandle,
    config: &HitlConfig,
    review: &PlanReviewMessage,
    decoded: Result<PlanReviewBody, ReviewBodyError>,
    was_encrypted: bool,
) {
    let label = window_label("review", &review.message_id);

    // The cache replay and the live stream overlap by design, so the same
    // review can arrive twice. Raising the existing window is right; rebuilding
    // it would discard whatever the human has already typed.
    if let Some(window) = app.get_webview_window(&label) {
        log::info!("Review window {} is already open", label);
        let _ = crate::window_utils::show_window_no_activate(&window);
        return;
    }

    if config.sound_enabled {
        crate::sound::play_notification();
    }

    app.state::<OutstandingReviews>()
        .remember(&review.message_id, &review.snapshot_hash);

    payload_store::put(
        app,
        &label,
        review_window_payload(
            review,
            &decoded,
            was_encrypted,
            &config.device_name,
            hitl_transport::drafts::load_for_window(
                &review.plan_id,
                &review.message_id,
                &review.snapshot_hash,
            ),
        ),
    );

    let title = if review.display_path.is_empty() {
        "Plan review".to_string()
    } else {
        format!("Plan review — {}", review.display_path)
    };

    match build_review_window(app, &label, &title) {
        Ok(window) => {
            log::info!("Review window created: {}", label);
            if let Err(e) = crate::window_utils::show_window_no_activate(&window) {
                log::error!("Failed to show review window {}: {}", label, e);
            }
        }
        Err(e) => {
            // The payload would otherwise sit in the store forever.
            app.state::<payload_store::PayloadStore>().take(&label);
            log::error!("Failed to create review window: {}", e);
        }
    }
}

/// Show (or update) the notifications window for an incoming notification.
fn show_notification(
    app: &AppHandle,
    config: &HitlConfig,
    notification: &NotificationMessage,
    was_encrypted: bool,
) {
    log::info!("Received notification: {}", notification.message_id);

    if config.sound_enabled {
        crate::sound::play_notification();
    }

    // Build a payload that includes the encrypted flag for the frontend
    let mut payload = serde_json::to_value(notification).unwrap_or_default();
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("_wasEncrypted".to_string(), serde_json::Value::Bool(was_encrypted));
    }
    // The cache-then-seed-later-window path: a sender_identity that arrived
    // before this notification card existed.
    let cached_sender = app.state::<SenderIdentityCacheState>().get(&notification.message_id);
    merge_cached_sender(&mut payload, cached_sender);
    let notification_json = serde_json::to_string(&payload).unwrap_or_default();
    let label = "notifications";

    if let Some(win) = app.get_webview_window(label) {
        if let Err(e) = win.emit("add-notification", &notification_json) {
            log::error!("Failed to emit add-notification: {}", e);
        }
        let _ = crate::window_utils::show_window_no_activate(&win);
        return;
    }

    let encoded = urlencoding::encode(&notification_json);
    let url_str = format!("notifications.html?notification={}", encoded);

    match tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::App(url_str.into()))
        .title("Notifications")
        .inner_size(400.0, 500.0)
        .center()
        .resizable(true)
        .decorations(false)
        .always_on_top(true)
        .visible(false)
        .focused(false)
        .build()
    {
        Ok(_) => log::info!("Notifications window created"),
        Err(e) => log::error!("Failed to create notifications window: {}", e),
    }
}

/// Create and show a dialog window for a question.
fn show_question(app: &AppHandle, config: &HitlConfig, question: &QuestionMessage, encrypted: bool) {
    let label = window_label("dialog", &question.message_id);

    // The same reasoning as show_review, and it applies just as hard here: the
    // cache replay and the live stream overlap by design, and the cache itself
    // can hold the same messageId twice. Rebuilding is not merely wasteful —
    // the failed build's cleanup below would take the payload back out of the
    // store while the first window's webview is still loading and about to
    // read it, leaving a permanent "could not load the question" panel on a
    // question nothing can now answer.
    if let Some(window) = app.get_webview_window(&label) {
        log::info!("Dialog window {} is already open", label);
        let _ = crate::window_utils::show_window_no_activate(&window);
        return;
    }

    if config.sound_enabled {
        crate::sound::play_notification();
    }

    // The cache-then-seed-later-window path: a sender_identity that arrived
    // before this dialog window existed.
    let mut payload = serde_json::to_value(question).unwrap_or_default();
    let cached_sender = app.state::<SenderIdentityCacheState>().get(&question.message_id);
    merge_cached_sender(&mut payload, cached_sender);
    let question_json = serde_json::to_string(&payload).unwrap_or_default();

    // The whole question used to be URL-encoded into the query string, which
    // does not survive a large payload and leaks content into anything that
    // logs URLs. `encrypted` stays on the URL: it is a flag, not content.
    payload_store::put(app, &label, question_json);
    let url_str = format!("index.html?encrypted={}", encrypted);

    match tauri::WebviewWindowBuilder::new(
        app,
        &label,
        tauri::WebviewUrl::App(url_str.into()),
    )
    .title("HITL")
    .inner_size(768.0, 768.0)
    .center()
    .resizable(true)
    .decorations(false)
    .always_on_top(true)
    .visible(false)
    .focused(false)
    .build()
    {
        Ok(_) => log::info!("Dialog window created: {}", label),
        Err(e) => {
            app.state::<payload_store::PayloadStore>().take(&label);
            log::error!("Failed to create dialog window: {}", e);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hitl_transport::payload::PayloadError;

    fn a_sender(label: &str) -> SenderInfo {
        SenderInfo { label: label.to_string(), source: "worktree".to_string() }
    }

    // --- Sender identity dispatch decision (Task 6) ---
    //
    // Window lookups are I/O this crate has no test harness for (no tauri
    // "test" feature, no dev-dependencies) — the same reason every other piece
    // of window logic in this file (window_label, review_window_payload) is
    // tested as a pure function. decide_sender_identity_action is that pure
    // extraction for the sender_identity arm: window-open-ness is injected as
    // a closure so tests never touch a real window.

    #[test]
    fn sender_identity_targets_the_dialog_window_when_it_is_already_open() {
        let action = decide_sender_identity_action("q-123", "question", |label| {
            label == "dialog-q-123"
        });

        match action {
            SenderIdentityAction::Emit(label) => assert_eq!(label, "dialog-q-123"),
            other => panic!("expected Emit, got {other:?}"),
        }
    }

    #[test]
    fn sender_identity_targets_the_shared_notifications_window_when_open() {
        let action = decide_sender_identity_action("n-456", "notification", |label| {
            label == "notifications"
        });

        match action {
            SenderIdentityAction::Emit(label) => assert_eq!(label, "notifications"),
            other => panic!("expected Emit, got {other:?}"),
        }
    }

    #[test]
    fn sender_identity_with_no_open_window_is_cached_not_emitted() {
        let action = decide_sender_identity_action("q-789", "question", |_| false);
        assert_eq!(action, SenderIdentityAction::Cache);
    }

    #[test]
    fn sender_identity_with_an_empty_for_message_id_is_dropped_not_panicked() {
        let action = decide_sender_identity_action("", "question", |_| {
            panic!("must not probe for a window when forMessageId is empty")
        });
        assert_eq!(action, SenderIdentityAction::Drop);
    }

    #[test]
    fn sender_identity_with_an_unrecognized_for_type_is_dropped() {
        let action = decide_sender_identity_action("q-1", "carrier_pigeon", |_| {
            panic!("must not probe for a window when forType is unrecognized")
        });
        assert_eq!(action, SenderIdentityAction::Drop);
    }

    // --- Seeding a newly-created window from the cache (Task 6, Step 7) ---

    #[test]
    fn merge_cached_sender_inserts_sender_when_present() {
        let mut payload = serde_json::json!({"messageId": "q-1"});
        merge_cached_sender(&mut payload, Some(a_sender("Kay9 - work-item/1")));

        assert_eq!(payload["sender"]["label"], "Kay9 - work-item/1");
        assert_eq!(payload["sender"]["source"], "worktree");
        // Existing fields must survive untouched.
        assert_eq!(payload["messageId"], "q-1");
    }

    #[test]
    fn merge_cached_sender_is_a_no_op_when_nothing_was_cached() {
        let mut payload = serde_json::json!({"messageId": "q-1"});
        merge_cached_sender(&mut payload, None);

        assert!(payload.get("sender").is_none());
    }

    // --- Window labels (W2.3 / W2.4) ---

    #[test]
    fn window_label_takes_the_first_eight_characters() {
        assert_eq!(
            window_label("dialog", "21ba33d7-08a8-4761-9abf-5f4e6ba364b1"),
            "dialog-21ba33d7"
        );
        assert_eq!(
            window_label("review", "21ba33d7-08a8-4761-9abf-5f4e6ba364b1"),
            "review-21ba33d7"
        );
    }

    #[test]
    fn window_label_distinguishes_a_review_from_a_dialog_with_the_same_id() {
        // The whole point of W2.4: an `answer` closes dialog-<id>, and that must
        // never be able to name the review window for the same id.
        let id = "abcdef01-2345";
        assert_ne!(window_label("dialog", id), window_label("review", id));
    }

    #[test]
    fn window_label_handles_short_and_multibyte_ids_without_panicking() {
        assert_eq!(window_label("dialog", "abc"), "dialog-abc");
        assert_eq!(window_label("dialog", ""), "dialog-");
        // Slicing [..8] on bytes would split these characters and panic.
        assert_eq!(window_label("review", "日本語のидентификатор"), "review-日本語のиден");
    }

    // --- Review window payload (W2.2 / W2.3 / C-2 / C-4) ---

    fn a_review() -> PlanReviewMessage {
        serde_json::from_str(
            r#"{"type":"plan_review","messageId":"rev-12345678","timestamp":7,
                "protocolVersion":2,"context":"c","summary":"s","displayPath":"docs/plan.md",
                "planId":"p1","revision":2,"isNewPlan":false,"snapshotHash":"sha256:aa",
                "body":{"kind":"attachment","contentHash":"bb","contentLength":9}}"#,
        )
        .unwrap()
    }

    #[test]
    fn review_payload_replaces_the_body_ref_with_the_decoded_body() {
        let decoded = Ok(PlanReviewBody {
            content: "# Plan\nline two\n".to_string(),
            diff: "@@ -1 +1 @@\n".to_string(),
        });

        let json: serde_json::Value = serde_json::from_str(&review_window_payload(
            &a_review(),
            &decoded,
            true,
            "Kay9",
            None,
        ))
        .unwrap();

        // The window has no use for a PlanPayloadRef; it needs the plan.
        assert_eq!(json["body"]["content"], "# Plan\nline two\n");
        assert_eq!(json["body"]["diff"], "@@ -1 +1 @@\n");
        assert!(json["body"].get("contentHash").is_none());
        assert_eq!(json["_error"], serde_json::Value::Null);
        assert_eq!(json["_wasEncrypted"], true);
        assert_eq!(json["_device"], "Kay9");
        // Metadata the window renders around the plan must survive intact.
        assert_eq!(json["revision"], 2);
        assert_eq!(json["displayPath"], "docs/plan.md");
        assert_eq!(json["snapshotHash"], "sha256:aa");
    }

    #[test]
    fn review_payload_names_an_expired_attachment_rather_than_going_blank() {
        // Guaranteed to happen: attachments live 3 h, messages 12 h, and the
        // cache is replayed with since=all on every client start.
        let decoded = Err(ReviewBodyError::Payload(PayloadError::Expired));

        let json: serde_json::Value = serde_json::from_str(&review_window_payload(
            &a_review(),
            &decoded,
            true,
            "Kay9",
            None,
        ))
        .unwrap();

        assert_eq!(json["body"], serde_json::Value::Null);
        assert_eq!(json["_error"]["kind"], "expired");
        assert!(!json["_error"]["message"].as_str().unwrap().is_empty());
        // The window still gets everything it needs to say WHICH plan expired.
        assert_eq!(json["displayPath"], "docs/plan.md");
        assert_eq!(json["messageId"], "rev-12345678");
    }

    #[test]
    fn a_saved_draft_rides_back_in_on_the_window_payload() {
        // The read half of save_review_draft. There is no separate command for
        // it: the window takes its payload once, so the draft has to be in it.
        let decoded = Ok(PlanReviewBody {
            content: "# Plan\n".to_string(),
            diff: "@@ -1 +1 @@\n".to_string(),
        });
        let draft = hitl_transport::drafts::ReviewDraft {
            review_id: "rev-12345678".to_string(),
            plan_id: "plan-abc".to_string(),
            snapshot_hash: "sha256:aa".to_string(),
            overall_feedback: "half-written thought".to_string(),
            inline_comments: vec![],
            saved_at: 7,
        };

        let json: serde_json::Value = serde_json::from_str(&review_window_payload(
            &a_review(),
            &decoded,
            false,
            "Kay9",
            Some(draft),
        ))
        .unwrap();

        assert_eq!(json["_draft"]["overallFeedback"], "half-written thought");
        assert_eq!(json["_draft"]["planId"], "plan-abc");
    }

    #[test]
    fn no_draft_is_an_explicit_null_rather_than_a_missing_key() {
        let decoded = Ok(PlanReviewBody {
            content: "# Plan\n".to_string(),
            diff: String::new(),
        });

        let json: serde_json::Value = serde_json::from_str(&review_window_payload(
            &a_review(),
            &decoded,
            false,
            "Kay9",
            None,
        ))
        .unwrap();

        assert_eq!(json["_draft"], serde_json::Value::Null);
    }

    // --- Review window sizing (E-9) ---

    #[test]
    fn a_review_window_fits_a_display_it_would_otherwise_overflow() {
        // E-9. 1366x768 is the case that breaks: 900 > 768, and .center() then
        // pushes the verdict footer off the bottom edge, leaving the plan
        // readable and unactionable.
        let (w, h) = fit_to_work_area(REVIEW_PREFERRED_SIZE, REVIEW_MIN_SIZE, (1366.0, 728.0));

        assert_eq!(w, 1280.0, "width already fits");
        assert_eq!(h, 728.0, "height must come down to the work area");
    }

    #[test]
    fn a_large_display_gets_the_preferred_size() {
        let (w, h) = fit_to_work_area(REVIEW_PREFERRED_SIZE, REVIEW_MIN_SIZE, (2560.0, 1400.0));

        assert_eq!((w, h), REVIEW_PREFERRED_SIZE);
    }

    #[test]
    fn a_narrow_display_shrinks_both_dimensions_independently() {
        let (w, h) = fit_to_work_area(REVIEW_PREFERRED_SIZE, REVIEW_MIN_SIZE, (1024.0, 1400.0));

        assert_eq!(w, 1024.0);
        assert_eq!(h, 900.0);
    }

    #[test]
    fn a_display_smaller_than_the_minimum_takes_the_display() {
        // Clamping up to the minimum would put the edges back off-screen,
        // which is the bug rather than the fix.
        let (w, h) = fit_to_work_area(REVIEW_PREFERRED_SIZE, REVIEW_MIN_SIZE, (640.0, 480.0));

        assert_eq!((w, h), (640.0, 480.0));
    }

    #[test]
    fn unusable_monitor_information_falls_back_to_the_preferred_size() {
        assert_eq!(
            fit_to_work_area(REVIEW_PREFERRED_SIZE, REVIEW_MIN_SIZE, (0.0, 0.0)),
            REVIEW_PREFERRED_SIZE
        );
    }
}
