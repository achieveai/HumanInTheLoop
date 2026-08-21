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
    /// Carried so that a failure recorded by the fetcher can name the event
    /// that referenced the body. The fetch happens on another task, long after
    /// the envelope that produced it is out of scope.
    pub ntfy_id: String,
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
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
                    self.archive.capture_body(
                        content_hash,
                        data,
                        self.encryption_key.as_deref(),
                        Some(&event.id),
                    );
                }
            }
            Some("attachment") => {
                let Some(attachment) = event
                    .attachment
                    .as_ref()
                    .filter(|a| !a.url.is_empty())
                else {
                    // The message says its body is an attachment and ntfy sent
                    // no attachment metadata. Nothing to fetch, and it will
                    // never become fetchable — say so once, loudly.
                    log::warn!(
                        "event {} declares an attachment body ({content_hash}) but carries no \
                         attachment URL; that body is unrecoverable",
                        event.id
                    );
                    self.archive.note_gone(
                        content_hash,
                        &event.id,
                        "the message declared an attachment body but ntfy sent no URL",
                    );
                    return;
                };

                // The gate that keeps the startup replay from growing without
                // bound. Every restart re-polls ntfy's whole cache, and past
                // the attachment expiry those URLs are permanently dead — so
                // without this, every boot would re-fetch every body ever
                // missed, forever, and the storm would grow with the cache
                // duration the user is raising.
                if attachment.is_gone(now_secs()) {
                    log::debug!(
                        "attachment for {content_hash} expired at {:?}; not fetching",
                        attachment.expires
                    );
                    // The most common permanent loss there is, and the one most
                    // easily mistaken for a body still on its way. Recorded so
                    // a reader is told "gone" rather than left waiting.
                    self.archive.note_gone(
                        content_hash,
                        &event.id,
                        &format!("ntfy dropped the attachment at {:?}", attachment.expires),
                    );
                    return;
                }

                let url = attachment.url.clone();
                if self
                    .bodies
                    .send(BodyJob {
                        url,
                        content_hash: content_hash.to_string(),
                        ntfy_id: event.id.clone(),
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

    use hitl_store::BodyStatus;
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
        attached(id, time, url, None)
    }

    fn attached(id: &str, time: u64, url: &str, expires: Option<u64>) -> NtfyEvent {
        NtfyEvent {
            id: id.to_string(),
            time,
            attachment: Some(AttachmentRef {
                name: "p.bin".to_string(),
                url: url.to_string(),
                content_type: None,
                size: None,
                expires,
            }),
            ..Default::default()
        }
    }

    /// Comfortably outside any clock skew, in both directions, so these tests
    /// do not depend on the wall clock they run under.
    fn long_ago() -> u64 {
        now_secs() - 30 * 24 * 3600
    }
    fn far_ahead() -> u64 {
        now_secs() + 30 * 24 * 3600
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
                ntfy_id: "ntfy-1".to_string(),
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
                .capture_body(&body_ref.content_hash, &encoded.cipher, None, Some("ntfy-t")),
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

    // --- Surviving a shutdown that killed a fetch in flight ---

    #[test]
    fn a_body_missing_after_a_restart_is_queued_again_by_the_cache_replay() {
        // The case that matters most in practice. The daemon is killed at
        // logout, sleep or reboot with a fetch in flight; on the next start
        // `subscribe_loop` polls ntfy's whole cache before subscribing, and
        // every cached event comes back through `on_event`. A body that never
        // landed must be queued again — otherwise a routine reboot loses a plan
        // permanently, which is the exact failure this binary exists to stop.
        let mut first_run = harness(None);
        let mut body_ref = encode_payload(&plan_body(), None).unwrap().payload_ref;
        body_ref.kind = "attachment".to_string();
        body_ref.data = None;
        let event = attached("ntfy-1", 1, "https://n/file/p.bin", Some(far_ahead()));

        first_run.sink.on_event(&event, &plan_review_message(&body_ref));
        assert!(first_run.jobs.try_recv().is_ok(), "queued on the first sighting");
        // ...and then the process dies before the fetcher gets to it.

        // Restart: same event, replayed off the cache, into a fresh sink whose
        // archive still has no body for it.
        let mut restarted = harness(None);
        restarted.sink.on_event(&event, &plan_review_message(&body_ref));

        assert_eq!(
            restarted.jobs.try_recv().ok(),
            Some(BodyJob {
                url: "https://n/file/p.bin".to_string(),
                content_hash: body_ref.content_hash.clone(),
                ntfy_id: "ntfy-1".to_string(),
            }),
            "a body that never landed must be retried on the next start"
        );
    }

    #[test]
    fn a_body_captured_before_the_restart_is_not_fetched_again() {
        // The other half: the replay must not re-fetch what is already held, or
        // every boot would spend a request per cached attachment.
        let mut h = harness(None);
        let encoded = encode_payload(&plan_body(), None).unwrap();
        let mut body_ref = encoded.payload_ref.clone();
        body_ref.kind = "attachment".to_string();
        body_ref.data = None;
        h.archive
            .capture_body(&body_ref.content_hash, &encoded.cipher, None, Some("ntfy-t"));

        h.sink.on_event(
            &attached("ntfy-1", 1, "https://n/file/p.bin", Some(far_ahead())),
            &plan_review_message(&body_ref),
        );

        assert_eq!(h.jobs.try_recv().ok(), None);
    }

    #[test]
    fn an_attachment_past_its_expiry_is_never_queued() {
        // Without this, every boot re-polls the whole cache and re-queues every
        // body ever missed — and that storm grows with the cache duration,
        // which the user is deliberately raising.
        let mut h = harness(None);
        let mut body_ref = encode_payload(&plan_body(), None).unwrap().payload_ref;
        body_ref.kind = "attachment".to_string();
        body_ref.data = None;

        h.sink.on_event(
            &attached("ntfy-1", 1, "https://n/file/p.bin", Some(long_ago())),
            &plan_review_message(&body_ref),
        );

        assert_eq!(h.jobs.try_recv().ok(), None, "a dead URL must not be fetched even once");
        assert_eq!(h.archive.count_events().unwrap(), 1, "the event is still recorded");
    }

    #[test]
    fn an_expired_attachment_does_not_stop_an_inline_body_being_captured() {
        // The gate is on the fetch, not on capture: an inline body has nothing
        // to expire and must still be stored.
        let h = harness(None);
        let encoded = encode_payload(&plan_body(), None).unwrap();
        assert_eq!(encoded.payload_ref.kind, "inline");

        h.sink.on_event(
            &attached("ntfy-1", 1, "https://n/file/p.bin", Some(long_ago())),
            &plan_review_message(&encoded.payload_ref),
        );

        assert!(h.archive.has_body(&encoded.payload_ref.content_hash));
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

    // --- Saying *why* a body is missing (spec 8.3) ---

    #[test]
    fn an_expired_attachment_is_recorded_as_gone_not_left_looking_unattempted() {
        // The most common permanent loss there is. Without a row, a reader sees
        // exactly what it sees for a body still in flight, and waits forever
        // for something ntfy deleted hours ago.
        let h = harness(None);
        let mut body_ref = encode_payload(&plan_body(), None).unwrap().payload_ref;
        body_ref.kind = "attachment".to_string();
        body_ref.data = None;

        h.sink.on_event(
            &attached("ntfy-1", 1, "https://n/file/p.bin", Some(long_ago())),
            &plan_review_message(&body_ref),
        );

        assert!(
            matches!(h.archive.body_status(&body_ref.content_hash), BodyStatus::Gone { .. }),
            "an expired attachment must read as gone"
        );
    }

    #[test]
    fn an_attachment_with_no_url_is_recorded_as_gone() {
        // Unrecoverable and never becoming recoverable, so it is a verdict, not
        // a pending fetch.
        let h = harness(None);
        let mut body_ref = encode_payload(&plan_body(), None).unwrap().payload_ref;
        body_ref.kind = "attachment".to_string();
        body_ref.data = None;

        h.sink
            .on_event(&event("ntfy-1", 1), &plan_review_message(&body_ref));

        assert!(matches!(
            h.archive.body_status(&body_ref.content_hash),
            BodyStatus::Gone { .. }
        ));
    }

    #[test]
    fn a_body_still_in_flight_is_not_recorded_as_failed() {
        // The counterpart, and the one that would do real damage if it broke:
        // a queued fetch must leave no verdict behind, or a body that is merely
        // late is written off before it has been tried once.
        let h = harness(None);
        let mut body_ref = encode_payload(&plan_body(), None).unwrap().payload_ref;
        body_ref.kind = "attachment".to_string();
        body_ref.data = None;

        h.sink.on_event(
            &attached("ntfy-1", 1, "https://n/file/p.bin", Some(far_ahead())),
            &plan_review_message(&body_ref),
        );

        assert_eq!(
            h.archive.body_status(&body_ref.content_hash),
            BodyStatus::Unattempted,
            "queued is not failed"
        );
        assert!(!h.archive.body_failed(&body_ref.content_hash), "and must stay fetchable");
    }

    #[test]
    fn a_corrupt_inline_body_reads_as_corrupt_and_names_where_the_bytes_went() {
        // Corruption and expiry are opposite problems — one means the bytes on
        // the server are wrong, the other that there are none. Before the
        // failure table both were `get_body() -> None`.
        let h = harness(None);
        let encoded = encode_payload(&plan_body(), None).unwrap();
        let mut body_ref = encoded.payload_ref.clone();
        let claimed = "0".repeat(64);
        body_ref.content_hash = claimed.clone();

        h.sink
            .on_event(&event("ntfy-1", 1), &plan_review_message(&body_ref));

        let BodyStatus::Corrupt { actual_hash, .. } = h.archive.body_status(&claimed) else {
            panic!("a body whose bytes do not match its hash must read as corrupt");
        };
        let actual = actual_hash.expect("diagnosis needs to know where the bytes went");
        assert!(h.archive.has_body(&actual), "and the quarantined bytes must be there");
        assert!(!h.archive.has_body(&claimed), "while the claimed hash still misses");
    }

    #[test]
    fn a_body_this_machine_has_no_key_for_is_distinguishable_from_a_lost_one() {
        // Actionable in a way the others are not: the bytes are fine and the
        // operator is one config line from reading them. Reporting it as
        // "gone" would send them looking for a problem that is not there.
        let h = harness(None);
        let encoded = encode_payload(&plan_body(), Some(KEY)).unwrap();

        h.sink
            .on_event(&event("ntfy-1", 1), &plan_review_message(&encoded.payload_ref));

        assert!(matches!(
            h.archive.body_status(&encoded.payload_ref.content_hash),
            BodyStatus::Undecryptable { .. }
        ));
    }

    #[test]
    fn a_captured_body_leaves_no_failure_behind() {
        let h = harness(None);
        let encoded = encode_payload(&plan_body(), None).unwrap();

        h.sink
            .on_event(&event("ntfy-1", 1), &plan_review_message(&encoded.payload_ref));

        assert_eq!(
            h.archive.body_status(&encoded.payload_ref.content_hash),
            BodyStatus::Verified
        );
    }
}
