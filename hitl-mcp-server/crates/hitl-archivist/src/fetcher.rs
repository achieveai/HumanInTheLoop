//! The task that races ntfy's attachment expiry.
//!
//! ntfy keeps messages for `cache-duration` but attachments only for
//! `attachment-expiry-duration` — 3 h by default (spec §8.3). A plan body over
//! 2 KB travels as an attachment, so a body not captured inside that window is
//! gone for good: no backfill recovers it, because the bytes no longer exist
//! anywhere. That single fact is why the archivist exists at all.
//!
//! # Recovering a fetch that died with the process
//!
//! The archivist is a daemon on a laptop. It is killed at logout, sleep, reboot
//! and update, routinely — and any fetch in flight at that moment dies with it.
//! That, not a crash, is the common way a body goes missing.
//!
//! Recovery is the startup cache poll, which `subscribe_loop` already performs
//! before the live subscription: every cached event is replayed through
//! [`crate::sink::ArchivistSink::on_event`], and any attachment body not
//! already in `bodies` is queued again. The URL has to come from ntfy's
//! envelope, because that is the only place it ever exists — it is assigned by
//! the PUT and never appears inside our own message, so it is not in the
//! `events` table and a sweep over local rows could not produce it.
//!
//! That costs nothing in reach. ntfy's cache window is far longer than its
//! attachment expiry (12 h against 3 h by default, and the user is raising the
//! former), so every attachment that is still *fetchable* is still in the
//! cache. Anything the poll cannot see was unrecoverable before we looked.
//!
//! # Not retrying forever
//!
//! Because the poll replays the whole cache on every boot, a body that can
//! never be fetched would be re-attempted on every boot for as long as its
//! event stays cached — and that window is exactly what the user is lengthening.
//! Two bounds stop it, at two different distances:
//!
//! 1. [`crate::sink`] refuses to queue an attachment whose `expires` has
//!    passed, so a URL ntfy has already dropped is never fetched even once.
//!    Cheap, and it needs no history — the verdict comes from ntfy itself.
//! 2. `body_failures` stops a hash that has already failed in a way a retry
//!    cannot fix. This one has to be *durable*, because the case it catches is
//!    exactly the one the first bound cannot see: an attachment still well
//!    inside its expiry whose bytes are corrupt. Its URL stays live, so the
//!    expiry gate waves it through on every boot, and an in-process set forgets
//!    it the moment the daemon is closed at logout — which is routinely.
//!
//! A *transient* failure is deliberately recorded nowhere: it stays queueable,
//! so the next reconnect or restart tries it again while the attachment lives.
//! Only a verdict a retry cannot overturn is written down.

use std::sync::Arc;

use tokio::sync::mpsc::UnboundedReceiver;

use hitl_transport::ntfy::dispatch::ReviewBodyError;
use hitl_transport::ntfy::http::download_attachment;
use hitl_transport::payload::PayloadError;

use crate::archive::{Archive, BodyOutcome};
use crate::sink::BodyJob;

/// Whether re-running this fetch could ever produce a different answer.
///
/// The distinction the retry policy turns on. A 404 means the bytes are gone
/// from the server; a hash mismatch means the bytes that exist are not the ones
/// the message describes, and fetching them again yields the same bytes; a
/// missing key will not appear mid-run. A network error is none of those.
fn is_permanent(error: &ReviewBodyError) -> bool {
    matches!(error, ReviewBodyError::Payload(PayloadError::Expired))
}

/// Drain fetch jobs until the sink is dropped.
pub async fn run(
    archive: Arc<Archive>,
    mut jobs: UnboundedReceiver<BodyJob>,
    encryption_key: Option<String>,
) {
    while let Some(job) = jobs.recv().await {
        fetch_one(&archive, &job, encryption_key.as_deref()).await;
    }
    log::info!("body fetcher stopped: no sink is sending any more");
}

async fn fetch_one(archive: &Archive, job: &BodyJob, key: Option<&str>) {
    if archive.has_body(&job.content_hash) {
        return;
    }
    // Survives the restart that an in-process set would not, which matters
    // because every restart replays the cache that queued this in the first
    // place. `capture_body` clears the row if the bytes ever do turn up.
    if archive.body_failed(&job.content_hash) {
        log::debug!("{} already failed in a way a retry cannot fix", job.content_hash);
        return;
    }

    let cipher = match download_attachment(&job.url).await {
        Ok(bytes) => bytes,
        Err(e) => {
            if is_permanent(&e) {
                log::warn!(
                    "attachment for {} is gone from the server ({e}); it will not be retried — \
                     that body is unrecoverable",
                    job.content_hash
                );
                archive.note_gone(&job.content_hash, &job.ntfy_id, &format!("{e}"));
            } else {
                // Recorded nowhere on purpose: the next reconnect or restart
                // replays the cache and tries again, and the attachment may
                // still be there. Writing a row here would abandon a body that
                // is merely late.
                log::warn!(
                    "could not fetch attachment for {} ({e}); will retry on the next replay",
                    job.content_hash
                );
            }
            return;
        }
    };

    // `capture_body` writes the failure row itself for a mismatch or a missing
    // key — it is the only place that knows which, and what the bytes hashed to.
    match archive.capture_body(&job.content_hash, &cipher, key, Some(&job.ntfy_id)) {
        BodyOutcome::Stored => log::info!("captured attachment body {}", job.content_hash),
        BodyOutcome::AlreadyHeld => {}
        other => log::error!("attachment body {} not captured: {other:?}", job.content_hash),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hash_is_attempted_until_it_is_given_up_on() {
        let archive = Archive::in_memory().unwrap();
        assert!(!archive.body_failed("sha-1"), "nothing is given up on to begin with");

        archive.note_gone("sha-1", "ntfy-1", "404 from the server");

        assert!(archive.body_failed("sha-1"), "a dead fetch must not repeat");
        assert!(!archive.body_failed("sha-2"), "and must not block anything else");
    }

    #[test]
    fn a_body_that_arrives_after_a_failure_becomes_fetchable_again() {
        // The row is a bound on retrying, not a tombstone. A transient error
        // that looked permanent once must not lock the body out forever.
        let archive = Archive::in_memory().unwrap();
        let encoded =
            hitl_transport::payload::encode_payload(&plan_body(), None).unwrap();
        let hash = &encoded.payload_ref.content_hash;
        archive.note_gone(hash, "ntfy-1", "404 during a proxy restart");
        assert!(archive.body_failed(hash));

        archive.capture_body(hash, &encoded.cipher, None, Some("ntfy-1"));

        assert!(!archive.body_failed(hash), "the bytes are here; the explanation is stale");
    }

    fn plan_body() -> hitl_transport::types::PlanReviewBody {
        hitl_transport::types::PlanReviewBody {
            content: "# Plan\n".to_string(),
            diff: String::new(),
        }
    }

    #[test]
    fn only_a_definitively_gone_attachment_is_given_up_on() {
        // The retry policy in one assertion. A 404/410 means the bytes left the
        // server; everything else may be this minute's problem only, and giving
        // up on it would discard a body that was still there.
        assert!(is_permanent(&ReviewBodyError::Payload(PayloadError::Expired)));

        assert!(!is_permanent(&ReviewBodyError::Network("timed out".into())));
        assert!(!is_permanent(&ReviewBodyError::Network("502".into())));
        assert!(!is_permanent(&ReviewBodyError::NoAttachment));
    }

    #[test]
    fn a_404_maps_to_the_permanent_case_by_the_kind_the_transport_reports() {
        // `download_attachment` turns 404 and 410 into exactly this error, so
        // the mapping above is the one that actually fires in production.
        let expired = ReviewBodyError::Payload(PayloadError::Expired);
        assert_eq!(expired.kind(), "expired");
        assert!(is_permanent(&expired));
    }
}
