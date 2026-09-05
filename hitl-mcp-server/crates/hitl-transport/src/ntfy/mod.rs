//! The ntfy transport, and the one seam it hands its side effects through.

pub mod dispatch;
pub mod http;
pub mod identity;
pub mod publish;
pub mod review;
pub mod subscribe;

use crate::ntfy::subscribe::NtfyEvent;
use crate::types::{
    AnswerMessage, AttachmentRef, CancelReviewMessage, DismissNotificationMessage,
    NotificationMessage, PlanReviewAckMessage, PlanReviewMessage, PlanReviewResponseMessage,
    QuestionMessage, RestoreNotificationMessage, SenderIdentityMessage,
};

/// Everything the transport needs to hand outward. Implemented by each host
/// application: the Tauri client opens windows, the inbox writes to a store, a
/// test implementation records calls.
///
/// This is what makes `dispatch_message` testable. Before it, dispatch reached
/// for a real `AppHandle` a dozen times, and a comment in `ntfy.rs` said in as
/// many words that this crate had no harness for that — so the 277-line
/// function at the centre of the client had no coverage at all.
///
/// Implementations MUST NOT block: the subscribe loop calls these inline, so a
/// slow one stops every later message from being dispatched.
pub trait NtfySink: Send + Sync {
    /// The subscription came up, or went away.
    fn on_connected(&self, connected: bool);
    /// One ntfy event arrived — whatever it turned out to be.
    fn on_message(&self);

    /// Every decoded event, handed over verbatim *before* anything interprets
    /// it. `decrypted` is the fully-reassembled message JSON; `event` is ntfy's
    /// own envelope, which carries the one thing the message body can never
    /// carry — ntfy's id and time, the total-order key (spec §4.3).
    ///
    /// Deliberately upstream of every filter below it. `dispatch_message`
    /// suppresses replays, drops settled questions on the cache path and
    /// ignores settlement types from a future protocol version — all correct
    /// for a UI that must not re-raise a window, and all wrong for a recorder
    /// whose entire job is to hold what actually arrived. A host that records
    /// has to see the events the UI is right to skip.
    ///
    /// Default: does nothing, because a UI host has nothing to record.
    fn on_event(&self, _event: &NtfyEvent, _decrypted: &str) {}

    fn on_question(&self, msg: &QuestionMessage, was_encrypted: bool);
    fn on_answer(&self, msg: &AnswerMessage);
    fn on_notification(&self, msg: &NotificationMessage, was_encrypted: bool);
    fn on_dismiss_notification(&self, msg: &DismissNotificationMessage);
    /// A targeted undo of one notification dismissal.
    ///
    /// Default no-op keeps older UI hosts source-compatible. Recorder hosts see
    /// the raw event through `on_event` before dispatch reaches this callback.
    fn on_restore_notification(&self, _msg: &RestoreNotificationMessage) {}

    fn on_plan_review(
        &self,
        msg: &PlanReviewMessage,
        was_encrypted: bool,
        attachment: Option<AttachmentRef>,
    );
    fn on_plan_review_response(&self, msg: &PlanReviewResponseMessage);
    fn on_plan_review_ack(&self, msg: &PlanReviewAckMessage);
    fn on_cancel_review(&self, msg: &CancelReviewMessage);

    /// Decoration for a question or notification. Never blocks, retries, or
    /// surfaces an error: an unmatched identity is dropped silently.
    fn on_sender_identity(&self, msg: &SenderIdentityMessage);

    /// True when a view for this message id is currently open. `kind` is the
    /// wire type of the message the view was raised for — "question",
    /// "notification", "plan_review". Deliberately not a window label: a label
    /// is a desktop concept, and this trait has to survive a mobile host.
    fn is_view_open(&self, message_id: &str, kind: &str) -> bool;

    /// A protocol version higher than this build understands, on a message a
    /// human is waiting for. `raw` is the undecoded body, because this build's
    /// reading of a future shape cannot be trusted past the envelope.
    fn on_unsupported_version(&self, message_id: &str, msg_type: &str, version: u32, raw: &str);
}

#[cfg(test)]
pub(crate) mod test_sink {
    use super::*;
    use std::sync::Mutex;

    #[derive(Debug, PartialEq, Eq)]
    pub enum Call {
        Connected(bool),
        Message,
        Question(String),
        Answer(String),
        Notification(String),
        DismissNotification(String),
        RestoreNotification(String, String),
        PlanReview(String),
        PlanReviewResponse(String),
        PlanReviewAck(String),
        CancelReview(String),
        SenderIdentity(String),
        UnsupportedVersion(String, u32),
    }

    /// Records what dispatch asked for, in order, and nothing else.
    #[derive(Default)]
    pub struct RecordingSink {
        pub calls: Mutex<Vec<Call>>,
        pub open_views: Mutex<Vec<String>>,
    }

    impl RecordingSink {
        /// The call log, formatted, so assertions read as the sequence of
        /// things that happened rather than as a struct comparison.
        pub fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().iter().map(|c| format!("{c:?}")).collect()
        }

        fn push(&self, c: Call) {
            self.calls.lock().unwrap().push(c);
        }
    }

    impl NtfySink for RecordingSink {
        fn on_connected(&self, c: bool) {
            self.push(Call::Connected(c));
        }
        fn on_message(&self) {
            self.push(Call::Message);
        }
        fn on_question(&self, m: &QuestionMessage, _: bool) {
            self.push(Call::Question(m.message_id.clone()));
        }
        fn on_answer(&self, m: &AnswerMessage) {
            self.push(Call::Answer(m.question_id.clone()));
        }
        fn on_notification(&self, m: &NotificationMessage, _: bool) {
            self.push(Call::Notification(m.message_id.clone()));
        }
        fn on_dismiss_notification(&self, m: &DismissNotificationMessage) {
            self.push(Call::DismissNotification(m.notification_id.clone()));
        }
        fn on_restore_notification(&self, m: &crate::types::RestoreNotificationMessage) {
            self.push(Call::RestoreNotification(
                m.notification_id.clone(),
                m.dismissal_id.clone(),
            ));
        }
        fn on_plan_review(&self, m: &PlanReviewMessage, _: bool, _: Option<AttachmentRef>) {
            self.push(Call::PlanReview(m.message_id.clone()));
        }
        fn on_plan_review_response(&self, m: &PlanReviewResponseMessage) {
            self.push(Call::PlanReviewResponse(m.review_id.clone()));
        }
        fn on_plan_review_ack(&self, m: &PlanReviewAckMessage) {
            self.push(Call::PlanReviewAck(m.review_id.clone()));
        }
        fn on_cancel_review(&self, m: &CancelReviewMessage) {
            self.push(Call::CancelReview(m.review_id.clone()));
        }
        fn on_sender_identity(&self, m: &SenderIdentityMessage) {
            self.push(Call::SenderIdentity(m.sender.label.clone()));
        }
        fn is_view_open(&self, id: &str, _: &str) -> bool {
            self.open_views.lock().unwrap().iter().any(|v| v == id)
        }
        fn on_unsupported_version(&self, id: &str, _: &str, v: u32, _: &str) {
            self.push(Call::UnsupportedVersion(id.to_string(), v));
        }
    }
}
