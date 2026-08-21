//! The Inbox's `NtfySink`: record, and tell the window something changed.
//!
//! Contrast with `TauriSink` in `hitl-client`, the other Tauri implementation
//! of this trait. That one raises a window per message and needs to know which
//! windows are open so sender identity can be routed to one. The Inbox has a
//! single window that re-reads the whole view, so it needs neither — every
//! per-message callback below is a deliberate no-op, and [`NtfySink::on_event`]
//! carries the entire behaviour.

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use hitl_store::Store;
use hitl_transport::ntfy::review::AckWaiters;
use hitl_transport::ntfy::subscribe::NtfyEvent;
use hitl_transport::ntfy::NtfySink;
use hitl_transport::types::{
    AnswerMessage, AttachmentRef, CancelReviewMessage, DismissNotificationMessage,
    NotificationMessage, PlanReviewAckMessage, PlanReviewMessage, PlanReviewResponseMessage,
    QuestionMessage, SenderIdentityMessage,
};
use tokio::sync::mpsc::UnboundedSender;

use crate::capture::{self, BodyJob};

/// `rusqlite::Connection` is `Send` but not `Sync`, and the subscribe loop and
/// the command handlers both reach for the store, so it is shared behind a
/// mutex rather than opened twice. Two connections would also mean two
/// high-water marks and a backfill cursor that disagreed with itself.
pub type SharedStore = Arc<Mutex<Store>>;

/// Called once per genuinely new event, never on a replay.
pub type OnChanged = Box<dyn Fn() + Send + Sync>;

pub struct InboxSink {
    store: SharedStore,
    changed: OnChanged,
    /// The submissions from *this* Inbox that are still waiting to hear whether
    /// the agent read them.
    ///
    /// The one per-message callback below that is not a no-op, and it has to
    /// be: `submit_review_response` registers a waiter and then blocks on it
    /// for 30 s. With nothing delivering the ack, every review submitted from
    /// the Inbox would stall for the full timeout and then report
    /// `unacknowledged` — telling the reviewer their work may not have landed
    /// when the agent had in fact confirmed it seconds earlier.
    waiters: Arc<AckWaiters>,
    /// Attachment bodies to fetch before ntfy drops them (spec §8.3).
    ///
    /// Unbounded on purpose: the send happens inline in the subscribe loop, and
    /// a bounded channel that filled would either block ingest or drop the one
    /// thing that cannot be recovered afterwards.
    jobs: UnboundedSender<BodyJob>,
    /// The highest seq this sink has already announced.
    ///
    /// `Store::append` is idempotent and hands back the seq the row already
    /// had, so a seq that does not advance means the event was a replay. ntfy
    /// replays its whole cache window on every reconnect; without this the
    /// window would be told to redraw once per cached message on every
    /// reconnect, for as far back as the cache goes.
    announced: AtomicI64,
}

impl InboxSink {
    pub fn new(
        store: SharedStore,
        waiters: Arc<AckWaiters>,
        jobs: UnboundedSender<BodyJob>,
        changed: OnChanged,
    ) -> Self {
        Self {
            store,
            changed,
            waiters,
            jobs,
            announced: AtomicI64::new(0),
        }
    }

    /// Record one event; returns whether it was new to the log.
    pub fn record(&self, event: &NtfyEvent, decrypted: &str) -> bool {
        let seq = {
            let store = match self.store.lock() {
                Ok(store) => store,
                Err(poisoned) => {
                    // A panic elsewhere must not silently stop the Inbox
                    // recording. The data behind the lock is a database handle,
                    // not an invariant a panic could have half-updated.
                    log::warn!("the store lock was poisoned; recovering");
                    poisoned.into_inner()
                }
            };
            match store.append(event, decrypted) {
                Ok(seq) => seq,
                Err(e) => {
                    // Loud, and on with the next event: a subscriber that
                    // aborted on one bad row would stop recording the good ones.
                    log::error!("could not record event {}: {e}", event.id);
                    return false;
                }
            }
        };

        seq > self.announced.fetch_max(seq, Ordering::SeqCst)
    }
}

impl NtfySink for InboxSink {
    fn on_event(&self, event: &NtfyEvent, decrypted: &str) {
        if self.record(event, decrypted) {
            (self.changed)();
        }

        // Every delivery, not just the new ones. A replay is exactly how a
        // fetch that died with the window gets retried, and the attachment URL
        // lives only on this envelope — it is never written into our payload,
        // so nothing recoverable from the log could raise it later.
        //
        // Run even when `record` reported nothing new (including an append that
        // failed): a plan body ntfy is about to delete must not be lost because
        // of a row that did not write.
        if let Ok(payload) = serde_json::from_str::<serde_json::Value>(decrypted) {
            capture::capture(&self.store, &self.jobs, &payload, event);
        }
    }

    fn on_connected(&self, connected: bool) {
        log::info!("ntfy subscription {}", if connected { "up" } else { "down" });
    }
    fn on_message(&self) {}

    // --- Everything the popup client does with a message, and the Inbox
    // --- deliberately does not: it renders from the log, not from a callback.

    fn on_question(&self, _msg: &QuestionMessage, _was_encrypted: bool) {}
    fn on_answer(&self, _msg: &AnswerMessage) {}
    fn on_notification(&self, _msg: &NotificationMessage, _was_encrypted: bool) {}
    fn on_dismiss_notification(&self, _msg: &DismissNotificationMessage) {}

    /// `_attachment` is genuinely unused, and that is not the bug it looks like.
    ///
    /// The attachment is captured in [`NtfySink::on_event`] above, off
    /// `event.attachment` — upstream of `dispatch_message`, which drops settled
    /// messages and anything from a future protocol version. Capturing here
    /// instead would silently skip exactly those, and would miss
    /// `plan_review_response` bodies, which spill the same way.
    fn on_plan_review(
        &self,
        _msg: &PlanReviewMessage,
        _was_encrypted: bool,
        _attachment: Option<AttachmentRef>,
    ) {
    }
    fn on_plan_review_response(&self, _msg: &PlanReviewResponseMessage) {}
    fn on_cancel_review(&self, _msg: &CancelReviewMessage) {}

    /// The one exception to the no-ops above (spec §9.3).
    ///
    /// `on_event` has already written this ack down, and the fold will read it
    /// — but a submit in flight is blocked on a `oneshot` right now, not on the
    /// next repaint. Delivering here is what turns a 30 s stall into an
    /// immediate answer. Every ack is offered; `AckWaiters` drops the ones that
    /// name nothing this process is waiting for, including another device's.
    fn on_plan_review_ack(&self, msg: &PlanReviewAckMessage) {
        self.waiters.deliver(msg.clone());
    }

    /// Recorded by `on_event` like anything else, and joined onto its message
    /// by `crate::identity` when the tree is next built. Nothing to route: the
    /// Inbox has one window, and it re-reads the whole view.
    fn on_sender_identity(&self, _msg: &SenderIdentityMessage) {}

    /// Never — the Inbox opens no per-message view. Same answer the archivist
    /// gives, and for the same reason.
    fn is_view_open(&self, _message_id: &str, _kind: &str) -> bool {
        false
    }

    /// No upgrade panel: a message from a newer protocol is still an event that
    /// happened, and `on_event` has already written it down.
    fn on_unsupported_version(&self, _id: &str, _msg_type: &str, _version: u32, _raw: &str) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Harness {
        sink: InboxSink,
        store: SharedStore,
        redraws: Arc<AtomicI64>,
        waiters: Arc<AckWaiters>,
        jobs: tokio::sync::mpsc::UnboundedReceiver<BodyJob>,
    }

    fn harness() -> Harness {
        let store: SharedStore = Arc::new(Mutex::new(Store::open_in_memory().unwrap()));
        let redraws = Arc::new(AtomicI64::new(0));
        let waiters = Arc::new(AckWaiters::default());
        let (tx, jobs) = tokio::sync::mpsc::unbounded_channel();
        let counter = redraws.clone();
        Harness {
            sink: InboxSink::new(
                store.clone(),
                waiters.clone(),
                tx,
                Box::new(move || {
                    counter.fetch_add(1, Ordering::SeqCst);
                }),
            ),
            store,
            redraws,
            waiters,
            jobs,
        }
    }

    fn event(id: &str, time: u64) -> NtfyEvent {
        NtfyEvent {
            id: id.to_string(),
            time,
            ..Default::default()
        }
    }

    fn question(id: &str) -> String {
        format!(r#"{{"type":"question","messageId":"{id}","question":"?"}}"#)
    }

    #[test]
    fn every_event_is_recorded_and_announced_once() {
        let h = harness();

        h.sink.on_event(&event("ntfy-1", 100), &question("q-1"));
        h.sink.on_event(&event("ntfy-2", 200), &question("q-2"));

        assert_eq!(h.store.lock().unwrap().count_events().unwrap(), 2);
        assert_eq!(h.redraws.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn a_replayed_event_is_not_announced_again() {
        // ntfy replays its whole cache window on every reconnect. Announcing
        // those would repaint the window once per cached message, every time
        // the connection blinks.
        let h = harness();
        let (e, body) = (event("ntfy-1", 100), question("q-1"));

        h.sink.on_event(&e, &body);
        h.sink.on_event(&e, &body);
        h.sink.on_event(&e, &body);

        assert_eq!(h.store.lock().unwrap().count_events().unwrap(), 1);
        assert_eq!(h.redraws.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_new_event_after_a_replay_is_still_announced() {
        let h = harness();
        h.sink.on_event(&event("ntfy-1", 100), &question("q-1"));
        h.sink.on_event(&event("ntfy-2", 200), &question("q-2"));

        // Reconnect: the window replays, then something genuinely new arrives.
        h.sink.on_event(&event("ntfy-1", 100), &question("q-1"));
        h.sink.on_event(&event("ntfy-2", 200), &question("q-2"));
        h.sink.on_event(&event("ntfy-3", 300), &question("q-3"));

        assert_eq!(h.redraws.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn an_event_a_popup_would_filter_out_is_still_recorded() {
        // `dispatch_message` drops settled questions off the cache path and
        // ignores settlement types from a future protocol version. `on_event`
        // runs upstream of all of it, which is the only reason the Inbox can
        // show history the popups never displayed.
        let h = harness();
        let too_new = r#"{"type":"answer","questionId":"q-1","protocolVersion":99,
                          "respondedFrom":"phone","selectedValues":["yes"],"skipped":false}"#;

        h.sink.on_event(&event("ntfy-9", 1), too_new);

        assert_eq!(h.store.lock().unwrap().count_events().unwrap(), 1);
    }

    #[test]
    fn an_undecodable_payload_is_recorded_as_having_happened() {
        let h = harness();
        h.sink.on_event(&event("ntfy-9", 1), "not json at all");

        assert_eq!(h.store.lock().unwrap().count_events().unwrap(), 1);
        assert_eq!(h.redraws.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_plan_reviews_attachment_is_captured_by_the_event_that_carried_it() {
        // The seam this sink used to drop on the floor. `on_plan_review` is
        // handed the attachment too, but it runs downstream of dispatch's
        // filtering — `on_event` sees every delivery, which is what makes the
        // capture survive a replay.
        let mut h = harness();
        let (_, body_ref) = crate::capture::tests::spilled(None);
        let event = crate::capture::tests::attached(
            "ntfy-1",
            "https://n/file/p.bin",
            Some(crate::capture::tests::far_ahead()),
        );

        h.sink
            .on_event(&event, &crate::capture::tests::plan_review(&body_ref));

        assert_eq!(
            h.jobs.try_recv().ok().map(|j| j.content_hash),
            Some(body_ref.content_hash),
            "an attachment body must be reached for at ingest, not on selection"
        );
        assert_eq!(h.store.lock().unwrap().count_events().unwrap(), 1);
    }

    #[test]
    fn a_body_capture_is_attempted_on_a_replay_too() {
        // A fetch that died with the window is retried only by the startup
        // replay, so a capture gated on "was this event new" would lose exactly
        // the bodies this exists to keep.
        let mut h = harness();
        let (_, body_ref) = crate::capture::tests::spilled(None);
        let event = crate::capture::tests::attached(
            "ntfy-1",
            "https://n/file/p.bin",
            Some(crate::capture::tests::far_ahead()),
        );
        let payload = crate::capture::tests::plan_review(&body_ref);

        h.sink.on_event(&event, &payload);
        h.sink.on_event(&event, &payload);

        assert_eq!(h.redraws.load(Ordering::SeqCst), 1, "announced once");
        assert!(h.jobs.try_recv().is_ok());
        assert!(h.jobs.try_recv().is_ok(), "but reached for on both deliveries");
    }

    #[test]
    fn the_inbox_never_claims_a_view_is_open() {
        let h = harness();
        assert!(!h.sink.is_view_open("q-1", "question"));
    }

    fn ack(review_id: &str, response_id: &str, status: &str) -> PlanReviewAckMessage {
        serde_json::from_str(&format!(
            r#"{{"type":"plan_review_ack","reviewId":"{review_id}",
                 "responseId":"{response_id}","status":"{status}"}}"#
        ))
        .unwrap()
    }

    #[test]
    fn an_ack_reaches_the_submission_that_is_waiting_for_it() {
        // `submit_plan_review` blocks on this for 30 s. Before the ack was
        // routed here it never arrived, so every review submitted from the
        // Inbox timed out and reported `unacknowledged` — "your work may not
        // have landed" — for a review the agent had already confirmed.
        let h = harness();
        let mut rx = h.waiters.register("r-1", "resp-A");

        h.sink.on_plan_review_ack(&ack("r-1", "resp-A", "received"));

        assert_eq!(rx.try_recv().unwrap().status, "received");
    }

    #[test]
    fn another_devices_ack_does_not_resolve_our_submission() {
        // Every device sees every ack: they are on the shared topic. Ours must
        // stay waiting, or a sibling's confirmation would be reported as our
        // own and the draft would be cleared on the strength of it.
        let h = harness();
        let mut rx = h.waiters.register("r-1", "resp-mine");

        h.sink.on_plan_review_ack(&ack("r-1", "resp-theirs", "received"));

        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn an_ack_for_nothing_we_submitted_is_harmless() {
        let h = harness();
        h.sink.on_plan_review_ack(&ack("r-9", "resp-Z", "lost"));
    }
}
