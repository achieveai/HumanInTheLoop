//! The recorder.
//!
//! Contrast with `TauriSink` in the client, the other implementation of the
//! same trait: that one opens windows, plays sounds and tracks which views are
//! showing. This one has no windows, no sound, no UI and no opinion about what
//! any message means. It writes down what arrived. Everything below
//! [`NtfySink::on_event`] is a deliberate no-op, and the empty method bodies
//! are the feature rather than an omission.

use std::sync::Arc;

use hitl_transport::ntfy::subscribe::NtfyEvent;
use hitl_transport::ntfy::NtfySink;
use hitl_transport::types::{
    AnswerMessage, AttachmentRef, CancelReviewMessage, DismissNotificationMessage,
    NotificationMessage, PlanReviewAckMessage, PlanReviewMessage, PlanReviewResponseMessage,
    QuestionMessage, SenderIdentityMessage,
};
use tokio::sync::mpsc::UnboundedSender;

use crate::archive::Archive;

/// One attachment to fetch before ntfy drops it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BodyJob {
    pub url: String,
    pub content_hash: String,
}

pub struct ArchivistSink {
    archive: Arc<Archive>,
    /// Handed to the fetcher task. Unbounded on purpose: this send happens
    /// inline in the subscribe loop, and a bounded channel that filled would
    /// either block ingest or drop the one thing that cannot be recovered.
    bodies: UnboundedSender<BodyJob>,
    encryption_key: Option<String>,
}

impl ArchivistSink {
    pub fn new(
        archive: Arc<Archive>,
        bodies: UnboundedSender<BodyJob>,
        encryption_key: Option<String>,
    ) -> Self {
        Self {
            archive,
            bodies,
            encryption_key,
        }
    }

    /// Capture whatever body this event carries.
    ///
    /// An **inline** body is already in our hands, so it is verified and stored
    /// right here — no fetch, no channel, nothing to expire.
    ///
    /// An **attachment** body has to be fetched, and the trait forbids blocking
    /// (the subscribe loop awaits these inline, so a 60 s attachment timeout
    /// would stall every later event behind it). So the job is handed to the
    /// fetcher task, which picks it up immediately. That is concurrency, not
    /// laziness: the fetch is started by the act of ingesting, not by someone
    /// later opening the message. Spec §8.3 gives us three hours; this costs
    /// milliseconds.
    fn capture_body_of(&self, payload: &serde_json::Value, event: &NtfyEvent) {
        let Some(body) = payload.get("body") else { return };

        let content_hash = body
            .get("contentHash")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        if content_hash.is_empty() || self.archive.has_body(content_hash) {
            return;
        }

        match body.get("kind").and_then(|v| v.as_str()) {
            Some("inline") => {
                if let Some(data) = body.get("data").and_then(|v| v.as_str()) {
                    self.archive
                        .capture_body(content_hash, data, self.encryption_key.as_deref());
                }
            }
            Some("attachment") => {
                let Some(url) = event
                    .attachment
                    .as_ref()
                    .map(|a| a.url.clone())
                    .filter(|u| !u.is_empty())
                else {
                    // The message says its body is an attachment and ntfy sent
                    // no attachment metadata. Nothing to fetch, and it will
                    // never become fetchable — say so once, loudly.
                    log::warn!(
                        "event {} declares an attachment body ({content_hash}) but carries no \
                         attachment URL; that body is unrecoverable",
                        event.id
                    );
                    return;
                };

                if self
                    .bodies
                    .send(BodyJob {
                        url,
                        content_hash: content_hash.to_string(),
                    })
                    .is_err()
                {
                    log::error!(
                        "the body fetcher is gone; attachment {content_hash} will expire uncaptured"
                    );
                }
            }
            _ => {}
        }
    }
}

impl NtfySink for ArchivistSink {
    fn on_event(&self, event: &NtfyEvent, decrypted: &str) {
        match self.archive.record(event, decrypted) {
            Ok(_) => {}
            Err(e) => {
                // Loud, and then on with the next event. A recorder that
                // aborted its subscription on one bad row would stop recording
                // the good ones too.
                log::error!("{e}");
                return;
            }
        }

        if let Ok(payload) = serde_json::from_str::<serde_json::Value>(decrypted) {
            self.capture_body_of(&payload, event);
        }
    }

    // --- Everything a UI would do, and this deliberately does not. ---

    fn on_connected(&self, connected: bool) {
        log::info!("ntfy subscription {}", if connected { "up" } else { "down" });
    }
    fn on_message(&self) {}

    fn on_question(&self, _msg: &QuestionMessage, _was_encrypted: bool) {}
    fn on_answer(&self, _msg: &AnswerMessage) {}
    fn on_notification(&self, _msg: &NotificationMessage, _was_encrypted: bool) {}
    fn on_dismiss_notification(&self, _msg: &DismissNotificationMessage) {}

    fn on_plan_review(
        &self,
        _msg: &PlanReviewMessage,
        _was_encrypted: bool,
        _attachment: Option<AttachmentRef>,
    ) {
    }
    fn on_plan_review_response(&self, _msg: &PlanReviewResponseMessage) {}
    fn on_plan_review_ack(&self, _msg: &PlanReviewAckMessage) {}
    fn on_cancel_review(&self, _msg: &CancelReviewMessage) {}

    fn on_sender_identity(&self, _msg: &SenderIdentityMessage) {}

    /// Never. There is no view to be open — which is the correct answer rather
    /// than a stub, and it routes sender identity down the "cache it" path.
    fn is_view_open(&self, _message_id: &str, _kind: &str) -> bool {
        false
    }

    /// Recorded like any other event by `on_event` above; there is no upgrade
    /// panel to raise and nobody here for it to raise one at.
    fn on_unsupported_version(&self, _id: &str, _msg_type: &str, _version: u32, _raw: &str) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    use hitl_transport::payload::encode_payload;
    use hitl_transport::types::PlanReviewBody;
    use tokio::sync::mpsc;

    use crate::archive::BodyOutcome;

    const KEY: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

    struct Harness {
        sink: ArchivistSink,
        archive: Arc<Archive>,
        jobs: mpsc::UnboundedReceiver<BodyJob>,
    }

    fn harness(key: Option<&str>) -> Harness {
        let archive = Arc::new(Archive::in_memory().unwrap());
        let (tx, jobs) = mpsc::unbounded_channel();
        Harness {
            sink: ArchivistSink::new(archive.clone(), tx, key.map(str::to_string)),
            archive,
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

    fn event_with_attachment(id: &str, time: u64, url: &str) -> NtfyEvent {
        NtfyEvent {
            id: id.to_string(),
            time,
            attachment: Some(AttachmentRef {
                name: "p.bin".to_string(),
                url: url.to_string(),
                content_type: None,
                size: None,
                expires: None,
            }),
            ..Default::default()
        }
    }

    /// A recorded stream: what ntfy actually hands a subscriber over a session.
    fn recorded_stream() -> Vec<(NtfyEvent, String)> {
        vec![
            (
                event("ntfy-1", 1_786_504_000),
                r#"{"type":"question","messageId":"q-1","question":"Proceed?"}"#.to_string(),
            ),
            (
                event("ntfy-2", 1_786_504_010),
                r#"{"type":"notification","messageId":"n-1","title":"built"}"#.to_string(),
            ),
            (
                event("ntfy-3", 1_786_504_020),
                r#"{"type":"answer","questionId":"q-1","respondedFrom":"phone",
                    "selectedValues":["yes"],"skipped":false}"#
                    .to_string(),
            ),
            (
                event("ntfy-4", 1_786_504_030),
                r#"{"type":"dismiss_notification","notificationId":"n-1","dismissedFrom":"laptop"}"#
                    .to_string(),
            ),
        ]
    }

    fn drive(sink: &ArchivistSink, stream: &[(NtfyEvent, String)]) {
        for (event, decrypted) in stream {
            sink.on_event(event, decrypted);
        }
    }

    #[test]
    fn every_event_in_a_recorded_stream_lands_exactly_once() {
        let h = harness(None);
        let stream = recorded_stream();

        drive(&h.sink, &stream);

        assert_eq!(h.archive.count_events().unwrap(), 4);
        assert_eq!(h.archive.stats.snapshot().0, 4);
    }

    #[test]
    fn a_reconnect_that_replays_overlapping_events_does_not_double_record() {
        // ntfy's `since=` is inclusive and it replays its cache window on every
        // reconnect, so overlap is the ordinary case, not a fault. The startup
        // cache poll overlaps the live stream for the same reason.
        let h = harness(None);
        let stream = recorded_stream();

        drive(&h.sink, &stream);
        // Reconnect: the last two events arrive again, then two new ones.
        drive(&h.sink, &stream[2..]);
        drive(
            &h.sink,
            &[(
                event("ntfy-5", 1_786_504_040),
                r#"{"type":"question","messageId":"q-2","question":"And now?"}"#.to_string(),
            )],
        );

        assert_eq!(h.archive.count_events().unwrap(), 5, "5 distinct ntfy ids, 7 deliveries");
    }

    #[test]
    fn a_whole_stream_replayed_from_scratch_adds_nothing() {
        // A restart re-polls `since=all` and re-ingests everything ntfy still
        // holds. That must be a no-op, not a second copy of the last 12 hours.
        let h = harness(None);
        let stream = recorded_stream();

        drive(&h.sink, &stream);
        drive(&h.sink, &stream);

        assert_eq!(h.archive.count_events().unwrap(), 4);
    }

    #[test]
    fn the_recorded_events_come_back_in_order_with_ntfys_own_ids_and_times() {
        let h = harness(None);
        drive(&h.sink, &recorded_stream());

        let got = h.archive.events_since(0, 100).unwrap();
        let ids: Vec<_> = got.iter().map(|e| e.ntfy_id.as_str()).collect();

        assert_eq!(ids, vec!["ntfy-1", "ntfy-2", "ntfy-3", "ntfy-4"]);
        assert_eq!(got[0].ntfy_time, 1_786_504_000);
        assert_eq!(got[0].msg_type, "question");
        assert_eq!(got[2].subject_id.as_deref(), Some("q-1"), "an answer points at its question");
    }

    #[test]
    fn an_event_a_ui_would_skip_is_still_recorded() {
        // Dispatch drops already-answered questions off the cache path and
        // ignores settlement types from a future protocol version. A recorder
        // that inherited those filters would lose exactly the history it is
        // for.
        let h = harness(None);
        let too_new = r#"{"type":"answer","questionId":"q-1","protocolVersion":99,
                          "respondedFrom":"phone","selectedValues":["yes"],"skipped":false}"#;

        h.sink.on_event(&event("ntfy-9", 1), too_new);

        assert_eq!(h.archive.count_events().unwrap(), 1);
    }

    #[test]
    fn an_undecodable_payload_is_still_recorded_as_having_happened() {
        let h = harness(None);
        h.sink.on_event(&event("ntfy-9", 1), "not json at all");

        assert_eq!(h.archive.count_events().unwrap(), 1);
    }

    // --- Attachment capture (spec 8.3) ---

    fn plan_body() -> PlanReviewBody {
        PlanReviewBody {
            content: "# Plan\n\nship it\n".to_string(),
            diff: String::new(),
        }
    }

    fn plan_review_message(body_ref: &hitl_transport::types::PlanPayloadRef) -> String {
        format!(
            r#"{{"type":"plan_review","messageId":"p-1","displayPath":"docs/plan.md","body":{}}}"#,
            serde_json::to_string(body_ref).unwrap()
        )
    }

    #[test]
    fn an_inline_body_is_verified_and_captured_without_any_fetch() {
        let mut h = harness(Some(KEY));
        let encoded = encode_payload(&plan_body(), Some(KEY)).unwrap();
        assert_eq!(encoded.payload_ref.kind, "inline", "fixture must be inline");

        h.sink
            .on_event(&event("ntfy-1", 1), &plan_review_message(&encoded.payload_ref));

        assert!(h.archive.has_body(&encoded.payload_ref.content_hash));
        assert_eq!(h.jobs.try_recv().ok(), None, "nothing to fetch");
    }

    #[test]
    fn an_attachment_body_is_queued_for_fetch_at_ingest() {
        let mut h = harness(Some(KEY));
        let mut body_ref = encode_payload(&plan_body(), Some(KEY)).unwrap().payload_ref;
        body_ref.kind = "attachment".to_string();
        body_ref.data = None;

        h.sink.on_event(
            &event_with_attachment("ntfy-1", 1, "https://n/file/p.bin"),
            &plan_review_message(&body_ref),
        );

        assert_eq!(
            h.jobs.try_recv().ok(),
            Some(BodyJob {
                url: "https://n/file/p.bin".to_string(),
                content_hash: body_ref.content_hash.clone(),
            }),
            "the fetch must be raised by the act of ingesting, not by a later read"
        );
    }

    #[test]
    fn a_body_already_held_is_not_queued_again_on_a_replay() {
        // The reconnect case: re-fetching an attachment already captured wastes
        // a request against a URL that has very likely already expired.
        let mut h = harness(None);
        let encoded = encode_payload(&plan_body(), None).unwrap();
        let mut body_ref = encoded.payload_ref.clone();
        body_ref.kind = "attachment".to_string();
        body_ref.data = None;

        assert_eq!(
            h.archive
                .capture_body(&body_ref.content_hash, &encoded.cipher, None),
            BodyOutcome::Stored
        );
        h.sink.on_event(
            &event_with_attachment("ntfy-1", 1, "https://n/file/p.bin"),
            &plan_review_message(&body_ref),
        );

        assert_eq!(h.jobs.try_recv().ok(), None);
    }

    #[test]
    fn a_review_response_body_is_captured_too() {
        // Responses carry a PlanPayloadRef of their own (types.rs:359) and
        // spill to an attachment on the same threshold, so they expire the same
        // way. Reading `body` off the payload rather than off one message type
        // is what covers both.
        let h = harness(None);
        let encoded = encode_payload(&plan_body(), None).unwrap();
        let message = format!(
            r#"{{"type":"plan_review_response","messageId":"r-1","reviewId":"p-1",
                 "verdict":"approved","body":{}}}"#,
            serde_json::to_string(&encoded.payload_ref).unwrap()
        );

        h.sink.on_event(&event("ntfy-1", 1), &message);

        assert!(h.archive.has_body(&encoded.payload_ref.content_hash));
    }

    #[test]
    fn a_message_with_no_body_reference_queues_nothing() {
        let mut h = harness(None);
        drive(&h.sink, &recorded_stream());

        assert_eq!(h.jobs.try_recv().ok(), None);
        assert_eq!(h.archive.stats.snapshot().1, 0);
    }

    #[test]
    fn an_attachment_body_with_no_url_is_not_queued() {
        // Unrecoverable, and it will never become recoverable. Queueing it
        // would put a job in the fetcher that can only ever fail.
        let mut h = harness(None);
        let mut body_ref = encode_payload(&plan_body(), None).unwrap().payload_ref;
        body_ref.kind = "attachment".to_string();
        body_ref.data = None;

        h.sink
            .on_event(&event("ntfy-1", 1), &plan_review_message(&body_ref));

        assert_eq!(h.jobs.try_recv().ok(), None);
        assert_eq!(h.archive.count_events().unwrap(), 1, "the event is still recorded");
    }
}
