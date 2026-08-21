//! The task that races ntfy's three-hour attachment expiry.
//!
//! ntfy keeps messages for `cache-duration` but attachments only for
//! `attachment-expiry-duration` — 3 h by default (spec §8.3). A plan body over
//! 2 KB travels as an attachment, so a body not captured inside that window is
//! gone for good: no backfill recovers it, because the bytes no longer exist
//! anywhere. That single fact is why the archivist exists at all.
//!
//! Jobs arrive from [`crate::sink::ArchivistSink`] the moment an event is
//! recorded, and this task is the only thing between them and the network.

use std::sync::Arc;

use tokio::sync::mpsc::UnboundedReceiver;

use hitl_transport::ntfy::http::download_attachment;

use crate::archive::{Archive, BodyOutcome};
use crate::sink::BodyJob;

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

    let cipher = match download_attachment(&job.url).await {
        Ok(bytes) => bytes,
        Err(e) => {
            // Expected past the expiry window on a `since=all` replay, and the
            // reason this is a warning rather than an error: a body that was
            // captured on a previous run is caught by the check above, so what
            // reaches here is a body genuinely lost before we ever saw it.
            log::warn!(
                "could not fetch attachment for {}: {e} — that body is now unrecoverable",
                job.content_hash
            );
            return;
        }
    };

    match archive.capture_body(&job.content_hash, &cipher, key) {
        BodyOutcome::Stored => {
            log::info!("captured attachment body {}", job.content_hash)
        }
        BodyOutcome::AlreadyHeld => {}
        other => log::error!("attachment body {} not captured: {other:?}", job.content_hash),
    }
}
