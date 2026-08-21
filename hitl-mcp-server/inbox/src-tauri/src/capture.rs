//! Catching a plan body before ntfy throws it away (spec §8.3, §11).
//!
//! A plan over ~2 KB does not travel inside the message; it spills to a ntfy
//! attachment, and ntfy deletes attachments after 3 h while keeping the
//! messages that reference them for 12 h. The attachment URL exists **only** on
//! the ntfy envelope — it is assigned by the PUT and never written into our own
//! payload — so it is not in the `events` table and no replay can reconstruct
//! it. Past that window the bytes are gone from everywhere we could reach.
//!
//! That is why this is a capture *at ingest* and not a fetch on selection.
//! A lazy path is not a slower version of this one; it is a path that cannot
//! work, because by the time a human clicks the message the URL is dead.
//!
//! # Why the Inbox does this at all, when the archivist already does
//!
//! Spec §11: *every client works when the archivist is down; it simply cannot
//! see further back than ntfy's 12 h window.* Before this module the Inbox's
//! only route to an attachment-backed plan was `GET /bodies/{hash}` on
//! loopback, so stopping the archivist turned a plan that had been sitting on
//! ntfy at ingest into "could not fetch the plan". The Inbox is a client; it
//! keeps its own copy.
//!
//! # Shape
//!
//! [`capture`] runs inline on the subscribe loop and must never block it, so it
//! only ever *decides*: an inline body is verified and stored on the spot, an
//! attachment becomes a [`BodyJob`] for [`run`] to fetch on another task. That
//! is concurrency, not laziness — the fetch is started by the act of ingesting.
//!
//! Nothing here touches `list_messages` or `list_sessions`, which stay pure
//! functions of `(events, now)`.

use hitl_store::{BodyFailure, CaptureOutcome, FailureReason, Store};
use hitl_transport::ntfy::dispatch::ReviewBodyError;
use hitl_transport::ntfy::http::download_attachment;
use hitl_transport::ntfy::subscribe::NtfyEvent;
use hitl_transport::payload::PayloadError;
use serde_json::Value;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};

use crate::sink::SharedStore;

/// One attachment to fetch before ntfy drops it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BodyJob {
    pub url: String,
    pub content_hash: String,
    /// Carried so a failure recorded by the fetcher can name the event that
    /// referenced the body. The fetch happens on another task, long after the
    /// envelope that produced it is out of scope.
    pub ntfy_id: String,
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// The encryption key as configured *now*.
///
/// Read per body rather than cached at startup, matching `get_body`: adding the
/// key to `~/.hitl/config.json` then takes effect on the next message that
/// arrives instead of on the next restart. Only reached for an event that
/// actually carries a body, which is rare enough that the read is free.
fn encryption_key() -> Option<String> {
    hitl_transport::config::load_config()
        .unwrap_or_default()
        .encryption_key
}

fn with_store<T>(store: &SharedStore, f: impl FnOnce(&Store) -> T) -> T {
    // The data behind the lock is a database handle, not an invariant a panic
    // could have half-updated, so a poisoned lock is recovered rather than
    // allowed to stop the Inbox capturing.
    let guard = store.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    f(&guard)
}

/// Record a body as unrecoverable, so a reader is told "gone" rather than left
/// waiting for something that is never coming.
pub(crate) fn note_gone(store: &SharedStore, content_hash: &str, ntfy_id: &str, detail: &str) {
    with_store(store, |s| {
        if let Err(e) = s.record_body_failure(&BodyFailure {
            content_hash,
            reason: FailureReason::Gone,
            actual_hash: None,
            detail: Some(detail),
            ntfy_id: Some(ntfy_id),
        }) {
            // The body is lost either way; this only costs a reader the
            // explanation, and stopping ingest over it would cost far more.
            log::error!("could not record why body {content_hash} is missing: {e}");
        }
    });
}

/// Capture whatever body this event carries. Never blocks, never panics.
///
/// Read off the payload's `body` rather than off one message type, so a
/// `plan_review_response` — which carries a `PlanPayloadRef` of its own and
/// spills on the same threshold — is covered by the same three lines.
pub fn capture(
    store: &SharedStore,
    jobs: &UnboundedSender<BodyJob>,
    payload: &Value,
    event: &NtfyEvent,
) {
    let Some(body) = payload.get("body") else { return };

    let content_hash = body
        .get("contentHash")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    // An empty hash is nothing to verify against and nothing a reader could
    // ever look up: the hash *is* the identity here.
    if content_hash.is_empty() {
        return;
    }
    // The replay gate. ntfy replays its whole cache window on every reconnect
    // and the startup poll re-reads it from scratch, so without this every boot
    // would re-fetch every attachment it already holds.
    if with_store(store, |s| s.has_body(content_hash).unwrap_or(false)) {
        return;
    }

    match body.get("kind").and_then(|v| v.as_str()) {
        Some("inline") => {
            // Already in our hands: verified and stored right here. No fetch,
            // no channel, nothing to expire.
            if let Some(data) = body.get("data").and_then(|v| v.as_str()) {
                let key = encryption_key();
                let outcome = with_store(store, |s| {
                    s.capture_body(content_hash, data, key.as_deref(), Some(&event.id))
                });
                report(content_hash, outcome);
            }
        }
        Some("attachment") => {
            let Some(attachment) = event.attachment.as_ref().filter(|a| !a.url.is_empty()) else {
                // The message says its body is an attachment and ntfy sent no
                // attachment metadata. Nothing to fetch, and it will never
                // become fetchable — say so once, loudly.
                log::warn!(
                    "event {} declares an attachment body ({content_hash}) but carries no \
                     attachment URL; that body is unrecoverable",
                    event.id
                );
                note_gone(
                    store,
                    content_hash,
                    &event.id,
                    "the message declared an attachment body but ntfy sent no URL",
                );
                return;
            };

            if attachment.is_gone(now_secs()) {
                // The most common permanent loss there is, and the one most
                // easily mistaken for a body still on its way.
                log::debug!(
                    "attachment for {content_hash} expired at {:?}; not fetching",
                    attachment.expires
                );
                note_gone(
                    store,
                    content_hash,
                    &event.id,
                    &format!("ntfy dropped the attachment at {:?}", attachment.expires),
                );
                return;
            }

            if jobs
                .send(BodyJob {
                    url: attachment.url.clone(),
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
        // Any spill kind a newer build invents. Nothing here knows how to fetch
        // it, and guessing would be worse than the archivist's copy.
        _ => {}
    }
}

/// Drain fetch jobs until the sink is dropped.
pub async fn run(store: SharedStore, mut jobs: UnboundedReceiver<BodyJob>) {
    while let Some(job) = jobs.recv().await {
        fetch_one(&store, &job).await;
    }
    log::info!("inbox body fetcher stopped: no sink is sending any more");
}

async fn fetch_one(store: &SharedStore, job: &BodyJob) {
    if !should_fetch(store, &job.content_hash) {
        return;
    }
    // The lock is deliberately not held across this await: an attachment gets
    // 60 s, and every ingest would queue behind it.
    let downloaded = download_attachment(&job.url).await;
    settle(store, job, downloaded);
}

/// Whether reaching for this body could still produce anything.
///
/// Both answers are durable, which is the point: the startup poll replays
/// ntfy's whole cache on every boot, so an in-process set would re-attempt a
/// body known to be corrupt once per restart for as long as its event stays
/// cached.
fn should_fetch(store: &SharedStore, content_hash: &str) -> bool {
    with_store(store, |s| {
        !s.has_body(content_hash).unwrap_or(false) && !s.body_failed(content_hash).unwrap_or(false)
    })
}

/// Turn one finished download into a stored body or a recorded reason.
///
/// Split out from [`fetch_one`] because this — not the HTTP call — is the
/// policy: which failures are verdicts and which are "try again next replay".
fn settle(store: &SharedStore, job: &BodyJob, downloaded: Result<String, ReviewBodyError>) {
    let cipher = match downloaded {
        Ok(cipher) => cipher,
        // 404/410: the bytes left the server. Fetching again yields the same
        // answer forever, so it is a verdict.
        Err(e @ ReviewBodyError::Payload(PayloadError::Expired)) => {
            log::warn!(
                "attachment for {} is gone from the server ({e}); that body is unrecoverable",
                job.content_hash
            );
            note_gone(store, &job.content_hash, &job.ntfy_id, &format!("{e}"));
            return;
        }
        // Recorded nowhere on purpose: the next reconnect or restart replays
        // the cache and tries again, and the attachment may still be there.
        // Writing a row here would abandon a body that is merely late.
        Err(e) => {
            log::warn!(
                "could not fetch attachment for {} ({e}); will retry on the next replay",
                job.content_hash
            );
            return;
        }
    };

    let key = encryption_key();
    // `capture_body` writes the failure row itself for a mismatch or a missing
    // key — it is the only place that knows which, and what the bytes hashed to.
    let outcome = with_store(store, |s| {
        s.capture_body(
            &job.content_hash,
            &cipher,
            key.as_deref(),
            Some(&job.ntfy_id),
        )
    });
    report(&job.content_hash, outcome);
}

/// Say what became of a body, at the level its outcome deserves.
fn report(content_hash: &str, outcome: CaptureOutcome) {
    match outcome {
        CaptureOutcome::Stored => log::info!("captured plan body {content_hash}"),
        CaptureOutcome::AlreadyHeld => {}
        CaptureOutcome::HashMismatch { expected, actual } => log::error!(
            "plan body hash mismatch: message claimed {expected}, bytes hash to {actual}. \
             Quarantined under the hash the bytes actually have; nothing is stored under the \
             claimed one."
        ),
        other => log::error!("plan body {content_hash} not captured: {other:?}"),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    use std::sync::{Arc, Mutex};

    use hitl_store::BodyStatus;
    use hitl_transport::payload::{encode_payload, sha256_hex};
    use hitl_transport::types::{AttachmentRef, PlanPayloadRef, PlanReviewBody};
    use tokio::sync::mpsc;

    pub(crate) fn plan() -> PlanReviewBody {
        PlanReviewBody {
            content: "# Plan\n\nship it\n".to_string(),
            diff: "@@ -0,0 +1 @@\n+ship it\n".to_string(),
        }
    }

    /// The payload of a plan review whose body lives in an attachment: the
    /// cipher that will come down the wire, and the reference the message
    /// carries. `encode_payload` decides inline-vs-attachment by size, so the
    /// kind is forced rather than fought with a megabyte fixture.
    pub(crate) fn spilled(key: Option<&str>) -> (String, PlanPayloadRef) {
        let encoded = encode_payload(&plan(), key).expect("encodes");
        let mut body_ref = encoded.payload_ref;
        body_ref.kind = "attachment".to_string();
        body_ref.data = None;
        (encoded.cipher, body_ref)
    }

    pub(crate) fn plan_review(body_ref: &PlanPayloadRef) -> String {
        format!(
            r#"{{"type":"plan_review","messageId":"p-1","displayPath":"docs/plan.md","body":{}}}"#,
            serde_json::to_string(body_ref).expect("serializes")
        )
    }

    pub(crate) fn attached(id: &str, url: &str, expires: Option<u64>) -> NtfyEvent {
        NtfyEvent {
            id: id.to_string(),
            time: 1,
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

    pub(crate) fn far_ahead() -> u64 {
        now_secs() + 30 * 24 * 3600
    }
    fn long_ago() -> u64 {
        now_secs() - 30 * 24 * 3600
    }

    struct Harness {
        store: SharedStore,
        tx: UnboundedSender<BodyJob>,
        jobs: mpsc::UnboundedReceiver<BodyJob>,
    }

    fn harness() -> Harness {
        let (tx, jobs) = mpsc::unbounded_channel();
        Harness {
            store: Arc::new(Mutex::new(Store::open_in_memory().expect("opens"))),
            tx,
            jobs,
        }
    }

    impl Harness {
        fn ingest(&self, event: &NtfyEvent, payload: &str) {
            let json: Value = serde_json::from_str(payload).expect("valid payload");
            capture(&self.store, &self.tx, &json, event);
        }
        fn status(&self, hash: &str) -> BodyStatus {
            with_store(&self.store, |s| s.body_status(hash).expect("reads"))
        }
        fn held(&self, hash: &str) -> bool {
            with_store(&self.store, |s| s.has_body(hash).expect("reads"))
        }
    }

    fn job(hash: &str) -> BodyJob {
        BodyJob {
            url: "https://n/file/p.bin".to_string(),
            content_hash: hash.to_string(),
            ntfy_id: "ntfy-1".to_string(),
        }
    }

    // --- What ingest decides ---

    #[test]
    fn an_inline_body_is_verified_and_stored_without_any_fetch() {
        let mut h = harness();
        let encoded = encode_payload(&plan(), None).expect("encodes");
        assert_eq!(encoded.payload_ref.kind, "inline", "fixture must be inline");

        h.ingest(&attached("ntfy-1", "", None), &plan_review(&encoded.payload_ref));

        assert!(h.held(&encoded.payload_ref.content_hash));
        assert_eq!(h.jobs.try_recv().ok(), None, "nothing to fetch");
    }

    #[test]
    fn an_attachment_body_is_queued_by_the_act_of_ingesting() {
        // The whole fix. ntfy deletes the bytes after 3 h and the URL exists
        // only on this envelope, so a fetch raised when the message is later
        // *selected* would be raised against a dead URL.
        let mut h = harness();
        let (_, body_ref) = spilled(None);

        h.ingest(
            &attached("ntfy-1", "https://n/file/p.bin", Some(far_ahead())),
            &plan_review(&body_ref),
        );

        assert_eq!(
            h.jobs.try_recv().ok(),
            Some(BodyJob {
                url: "https://n/file/p.bin".to_string(),
                content_hash: body_ref.content_hash.clone(),
                ntfy_id: "ntfy-1".to_string(),
            })
        );
    }

    #[test]
    fn a_review_response_body_is_captured_too() {
        // Responses carry a `PlanPayloadRef` of their own and spill on the same
        // threshold. Reading `body` off the payload rather than off one message
        // type is what covers both.
        let h = harness();
        let encoded = encode_payload(&plan(), None).expect("encodes");
        let message = format!(
            r#"{{"type":"plan_review_response","messageId":"r-1","reviewId":"p-1",
                 "verdict":"approved","body":{}}}"#,
            serde_json::to_string(&encoded.payload_ref).expect("serializes")
        );

        h.ingest(&attached("ntfy-1", "", None), &message);

        assert!(h.held(&encoded.payload_ref.content_hash));
    }

    #[test]
    fn a_replay_of_a_body_already_held_queues_nothing() {
        // ntfy replays its whole cache on every reconnect, and the startup poll
        // re-reads it from scratch. Without this gate every boot would spend a
        // request per cached attachment, against URLs that have mostly expired.
        let mut h = harness();
        let (cipher, body_ref) = spilled(None);
        settle(&h.store, &job(&body_ref.content_hash), Ok(cipher));

        h.ingest(
            &attached("ntfy-1", "https://n/file/p.bin", Some(far_ahead())),
            &plan_review(&body_ref),
        );

        assert_eq!(h.jobs.try_recv().ok(), None);
    }

    #[test]
    fn a_body_that_never_landed_is_queued_again_on_the_next_start() {
        // The Inbox is a window someone closes. A fetch in flight dies with it,
        // and the startup replay is the only thing that retries it.
        let mut first_run = harness();
        let (_, body_ref) = spilled(None);
        let event = attached("ntfy-1", "https://n/file/p.bin", Some(far_ahead()));

        first_run.ingest(&event, &plan_review(&body_ref));
        assert!(first_run.jobs.try_recv().is_ok(), "queued on the first sighting");

        let mut restarted = harness();
        restarted.ingest(&event, &plan_review(&body_ref));

        assert_eq!(
            restarted.jobs.try_recv().ok().map(|j| j.content_hash),
            Some(body_ref.content_hash.clone())
        );
    }

    #[test]
    fn an_attachment_past_its_expiry_is_recorded_gone_rather_than_fetched() {
        let mut h = harness();
        let (_, body_ref) = spilled(None);

        h.ingest(
            &attached("ntfy-1", "https://n/file/p.bin", Some(long_ago())),
            &plan_review(&body_ref),
        );

        assert_eq!(h.jobs.try_recv().ok(), None, "a dead URL must not be fetched even once");
        assert!(
            matches!(h.status(&body_ref.content_hash), BodyStatus::Gone { .. }),
            "and a reader must be told, not left waiting"
        );
    }

    #[test]
    fn an_attachment_body_with_no_url_is_recorded_gone() {
        let mut h = harness();
        let (_, body_ref) = spilled(None);

        h.ingest(&attached("ntfy-1", "", None), &plan_review(&body_ref));

        assert_eq!(h.jobs.try_recv().ok(), None);
        assert!(matches!(h.status(&body_ref.content_hash), BodyStatus::Gone { .. }));
    }

    #[test]
    fn a_queued_body_is_not_yet_a_failed_one() {
        // The counterpart that would do real damage if it broke: a body merely
        // in flight must leave no verdict behind, or it is written off before
        // it has been tried once.
        let h = harness();
        let (_, body_ref) = spilled(None);

        h.ingest(
            &attached("ntfy-1", "https://n/file/p.bin", Some(far_ahead())),
            &plan_review(&body_ref),
        );

        assert_eq!(h.status(&body_ref.content_hash), BodyStatus::Unattempted);
    }

    #[test]
    fn a_message_with_no_body_or_no_hash_decides_nothing() {
        let mut h = harness();

        h.ingest(
            &attached("ntfy-1", "https://n/file/p.bin", None),
            r#"{"type":"question","messageId":"q-1","question":"?"}"#,
        );
        h.ingest(
            &attached("ntfy-2", "https://n/file/p.bin", None),
            r#"{"type":"plan_review","messageId":"p-2","body":{"kind":"attachment","contentHash":""}}"#,
        );

        assert_eq!(h.jobs.try_recv().ok(), None);
    }

    // --- What a finished download settles into ---

    #[test]
    fn a_downloaded_body_that_verifies_is_stored_under_the_hash_it_claimed() {
        let h = harness();
        let (cipher, body_ref) = spilled(None);

        settle(&h.store, &job(&body_ref.content_hash), Ok(cipher));

        assert!(h.held(&body_ref.content_hash));
        assert_eq!(h.status(&body_ref.content_hash), BodyStatus::Verified);
    }

    #[test]
    fn bytes_that_do_not_match_the_claimed_hash_are_never_stored_under_it() {
        // Spec §8.3's central rule. If this ever stores under the claimed hash,
        // every later reader treats corrupt bytes as verified content and the
        // read-only warning can never fire, because nothing can detect it.
        let h = harness();
        let (cipher, _) = spilled(None);
        let claimed = "0".repeat(64);

        settle(&h.store, &job(&claimed), Ok(cipher.clone()));

        assert!(!h.held(&claimed), "the claimed hash must miss");
        let BodyStatus::Corrupt { actual_hash, .. } = h.status(&claimed) else {
            panic!("bytes that fail the hash check must read as corrupt");
        };
        assert_eq!(actual_hash.as_deref(), Some(sha256_hex(&cipher).as_str()));
        assert!(h.held(&sha256_hex(&cipher)), "quarantined, for diagnosis");
    }

    #[test]
    fn a_body_this_machine_has_no_key_for_is_distinguishable_from_a_lost_one() {
        // Actionable in a way the others are not: the bytes are fine and the
        // reader is one config line from them.
        let h = harness();
        let (cipher, body_ref) = spilled(Some(
            "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
        ));

        settle(&h.store, &job(&body_ref.content_hash), Ok(cipher));

        assert!(matches!(
            h.status(&body_ref.content_hash),
            BodyStatus::Undecryptable { .. }
        ));
    }

    #[test]
    fn a_404_is_a_verdict_and_a_timeout_is_not() {
        // The retry policy in one test. 404/410 means the bytes left the
        // server; everything else may be this minute's problem only, and
        // recording it would abandon a body that is merely late.
        let h = harness();

        settle(
            &h.store,
            &job("sha-expired"),
            Err(ReviewBodyError::Payload(PayloadError::Expired)),
        );
        settle(
            &h.store,
            &job("sha-flaky"),
            Err(ReviewBodyError::Network("timed out".to_string())),
        );

        assert!(matches!(h.status("sha-expired"), BodyStatus::Gone { .. }));
        assert_eq!(h.status("sha-flaky"), BodyStatus::Unattempted, "still queueable");
    }

    #[test]
    fn a_body_already_held_is_not_fetched_again() {
        let h = harness();
        let (cipher, body_ref) = spilled(None);
        settle(&h.store, &job(&body_ref.content_hash), Ok(cipher));

        assert!(!should_fetch(&h.store, &body_ref.content_hash));
    }

    #[test]
    fn a_body_that_failed_permanently_is_not_fetched_again() {
        // Durable on purpose: the startup poll replays the cache on every boot,
        // so an in-process set would re-attempt a corrupt body once per restart.
        let h = harness();
        note_gone(&h.store, "sha-gone", "ntfy-1", "404");

        assert!(!should_fetch(&h.store, "sha-gone"));
        assert!(should_fetch(&h.store, "sha-untouched"), "and blocks nothing else");
    }
}
