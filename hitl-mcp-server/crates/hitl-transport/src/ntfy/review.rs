// -----------------------------------------------------------
// Plan review submission (W2.7)
// -----------------------------------------------------------

use crate::config::load_config;
use crate::crypto;
use crate::ntfy::dispatch::clip_chars;
use crate::ntfy::http::{http_client, ATTACHMENT_TIMEOUT};
use crate::ntfy::publish::publish_message;
use crate::payload;
use crate::types::{
    HitlConfig, PlanReviewAckMessage, PlanReviewResponseBody, PlanReviewResponseMessage,
    SUPPORTED_PROTOCOL_VERSION,
};

/// Ceiling for the `X-Message` header carrying the outer message alongside an
/// attachment PUT.
///
/// Measured against ntfy.sh: 7317 bytes succeeded, 16317 returned nginx's
/// `Request Header Or Cookie Too Large`. The real limit is nginx's 8 KB
/// `large_client_header_buffers`, not ntfy — so half of it is the margin
/// against a proxy configured smaller. Our encrypted metadata is ~600-900
/// bytes, roughly 20 % of this budget.
const X_MESSAGE_MAX_BYTES: usize = 4096;

/// How long a submitting window waits to learn the agent actually read it.
const ACK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// What the review window learns about its own submission.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanReviewSubmitResult {
    /// "received" — the agent decoded it · "lost" — the agent could not, re-offer
    /// the draft · "unacknowledged" — no answer within ACK_TIMEOUT, keep the draft.
    pub status: String,
    pub response_id: String,
    pub reason: Option<String>,
}

struct AckWaiter {
    review_id: String,
    response_id: String,
    tx: tokio::sync::oneshot::Sender<PlanReviewAckMessage>,
}

/// Reviews this client has shown and that nobody has settled yet.
///
/// Closing a review window resolves nothing (D-7) — the agent stays blocked —
/// so entries are removed when the review is actually settled, not when its
/// window goes away. That is what lets the tray release an agent whose window
/// the user closed hours ago.
#[derive(Default)]
pub struct OutstandingReviews(std::sync::Mutex<std::collections::HashMap<String, String>>);

impl OutstandingReviews {
    pub fn remember(&self, review_id: &str, snapshot_hash: &str) {
        if let Ok(mut open) = self.0.lock() {
            open.insert(review_id.to_string(), snapshot_hash.to_string());
        }
    }

    pub fn settle(&self, review_id: &str) {
        if let Ok(mut open) = self.0.lock() {
            open.remove(review_id);
        }
    }

    /// Every unsettled review, as `(reviewId, snapshotHash)`.
    pub fn snapshot(&self) -> Vec<(String, String)> {
        self.0
            .lock()
            .map(|open| open.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
            .unwrap_or_default()
    }
}

/// Submissions waiting to hear back from the agent.
///
/// Without this the window shows "submitted" the instant the PUT returns — even
/// though the response attachment can expire (3 h) before a reconnecting server
/// ever reads it, at which point the human's review is simply gone and nobody
/// knows.
#[derive(Default)]
pub struct AckWaiters(std::sync::Mutex<Vec<AckWaiter>>);

/// Does this ack answer the submission identified by these ids?
///
/// `responseId` is the precise answer; `reviewId` is the fallback for an ack
/// published by a server that could not decode far enough to learn which
/// response it was — exactly the `status:"lost"` case, which is the one the
/// window most needs to hear about.
fn ack_matches(ack: &PlanReviewAckMessage, review_id: &str, response_id: &str) -> bool {
    if !ack.response_id.is_empty() {
        return ack.response_id == response_id;
    }
    !ack.review_id.is_empty() && ack.review_id == review_id
}

impl AckWaiters {
    fn register(
        &self,
        review_id: &str,
        response_id: &str,
    ) -> tokio::sync::oneshot::Receiver<PlanReviewAckMessage> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        if let Ok(mut waiters) = self.0.lock() {
            waiters.push(AckWaiter {
                review_id: review_id.to_string(),
                response_id: response_id.to_string(),
                tx,
            });
        }
        rx
    }

    fn forget(&self, response_id: &str) {
        if let Ok(mut waiters) = self.0.lock() {
            waiters.retain(|w| w.response_id != response_id);
        }
    }

    pub fn deliver(&self, ack: PlanReviewAckMessage) {
        let Ok(mut waiters) = self.0.lock() else { return };
        let Some(index) = waiters
            .iter()
            .position(|w| ack_matches(&ack, &w.review_id, &w.response_id))
        else {
            log::debug!(
                "plan_review_ack for review {} response {} matched no pending submission",
                ack.review_id,
                ack.response_id
            );
            return;
        };

        let waiter = waiters.remove(index);
        let _ = waiter.tx.send(ack);
    }
}

/// Publish a plan-review response, spilling the body to an ntfy attachment when
/// it does not fit inline.
///
/// One ntfy message either way (C-1): with an attachment the outer message
/// rides in the `X-Message` header of the same PUT.
async fn publish_review_response(
    config: &HitlConfig,
    response: &PlanReviewResponseMessage,
    attachment_cipher: Option<&str>,
    encrypted: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let outer = serde_json::to_string(response)?;

    let Some(cipher) = attachment_cipher else {
        return publish_message(config, &outer, encrypted).await;
    };

    let wire = if encrypted {
        match config.encryption_key.as_ref() {
            Some(key) => crypto::encrypt(&outer, key)
                .map_err(|e| -> Box<dyn std::error::Error> { e.into() })?,
            None => outer,
        }
    } else {
        outer
    };

    if wire.len() > X_MESSAGE_MAX_BYTES {
        return Err(format!(
            "review metadata is {} bytes, over the {} byte X-Message budget",
            wire.len(),
            X_MESSAGE_MAX_BYTES
        )
        .into());
    }

    // Random hex, never anything derived from the plan: `Filename` is echoed
    // back as plaintext ntfy metadata, outside our encryption (F-9).
    let filename = format!("{}.bin", uuid::Uuid::new_v4().simple());
    let url = format!(
        "{}/{}",
        config.ntfy_url.trim_end_matches('/'),
        config.topic_id
    );

    let http = http_client(Some(ATTACHMENT_TIMEOUT), None);
    let sent = http
        .put(&url)
        .header("Filename", &filename)
        .header("X-Message", &wire)
        .header("Content-Type", "application/octet-stream")
        .body(cipher.to_string())
        .send()
        .await?;

    if !sent.status().is_success() {
        let status = sent.status();
        // Deliberately not parsed: an oversized header is answered by nginx
        // with HTML, not ntfy's {code,http,error,link} envelope, and a JSON
        // parse error on top of the real failure helps nobody.
        let body = clip_chars(&sent.text().await.unwrap_or_default(), 200);
        return Err(format!("ntfy attachment upload failed: {status} — {body}").into());
    }

    Ok(())
}

/// Publish a review verdict and wait to hear that the agent read it.
///
/// Shared by the review window's submit button and the tray's cancel item.
///
/// `waiters` and `outstanding` are passed in rather than reached for: the
/// transport used to pull them off a Tauri `AppHandle`, which is the one place
/// the dependency ran backwards.
pub async fn submit_review_response(
    waiters: &AckWaiters,
    outstanding: &OutstandingReviews,
    review_id: String,
    snapshot_hash: String,
    verdict: String,
    body: PlanReviewResponseBody,
    encrypted: bool,
) -> Result<PlanReviewSubmitResult, String> {
    let config = load_config().map_err(|e| e.to_string())?;
    let key = if encrypted {
        config.encryption_key.as_deref()
    } else {
        None
    };

    let encoded = match payload::encode_payload(&body, key) {
        Ok(encoded) => encoded,
        Err(e) => {
            // Logged with detail for us; returned as the plain `Display`
            // message, which for `TooLargeToSubmit` is already the
            // human-actionable text shown in the review window — nothing
            // about compressed bytes or gzip leaks through.
            log::warn!("Refused to submit review {review_id}: {e}");
            return Err(e.to_string());
        }
    };
    let response_id = uuid::Uuid::new_v4().to_string();

    let message = PlanReviewResponseMessage {
        msg_type: "plan_review_response".to_string(),
        message_id: response_id.clone(),
        timestamp: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
        protocol_version: Some(SUPPORTED_PROTOCOL_VERSION),
        review_id: review_id.clone(),
        responded_from: config.device_name.clone(),
        verdict: verdict.clone(),
        snapshot_hash,
        body: Some(encoded.payload_ref.clone()),
    };

    let attachment_cipher = (encoded.payload_ref.kind == "attachment").then_some(encoded.cipher.as_str());

    // Register before publishing: an ack can arrive before the PUT's own
    // response does, and a waiter registered afterwards would miss it.
    let ack_rx = waiters.register(&review_id, &response_id);

    if let Err(e) = publish_review_response(&config, &message, attachment_cipher, encrypted).await {
        waiters.forget(&response_id);
        log::error!("Failed to publish review {} response: {}", review_id, e);
        return Err(e.to_string());
    }

    log::info!(
        "Published {} for review {} ({} payload, response {})",
        verdict,
        review_id,
        encoded.payload_ref.kind,
        response_id
    );

    // Settled from this client's point of view the moment it is on the wire:
    // the tray must not offer to cancel a review the human has just answered.
    outstanding.settle(&review_id);

    let result = match tokio::time::timeout(ACK_TIMEOUT, ack_rx).await {
        Ok(Ok(ack)) => {
            log::info!(
                "Review {} acknowledged: {}{}",
                review_id,
                ack.status,
                ack.reason.as_deref().map(|r| format!(" ({r})")).unwrap_or_default()
            );
            PlanReviewSubmitResult {
                status: ack.status,
                response_id,
                reason: ack.reason,
            }
        }
        // Sender dropped without sending — treat exactly like a timeout rather
        // than inventing a fourth state the window would have to handle.
        Ok(Err(_)) | Err(_) => {
            waiters.forget(&response_id);
            log::warn!(
                "Review {} was published but not acknowledged within {}s",
                review_id,
                ACK_TIMEOUT.as_secs()
            );
            PlanReviewSubmitResult {
                status: "unacknowledged".to_string(),
                response_id,
                reason: Some(format!(
                    "No acknowledgement from the agent within {}s. The review was published; keep the draft until it is confirmed.",
                    ACK_TIMEOUT.as_secs()
                )),
            }
        }
    };

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- Acknowledgement matching (W2.7 / C-12) ---

    fn ack(review_id: &str, response_id: &str, status: &str) -> PlanReviewAckMessage {
        serde_json::from_str(&format!(
            r#"{{"type":"plan_review_ack","reviewId":"{review_id}",
                 "responseId":"{response_id}","status":"{status}"}}"#
        ))
        .unwrap()
    }

    #[test]
    fn ack_matches_on_response_id_when_the_server_knows_it() {
        assert!(ack_matches(&ack("r-1", "p-1", "received"), "r-1", "p-1"));
        assert!(
            !ack_matches(&ack("r-1", "p-2", "received"), "r-1", "p-1"),
            "a sibling device's response must not resolve our submission"
        );
    }

    #[test]
    fn ack_falls_back_to_review_id_when_the_response_could_not_be_identified() {
        // The status:"lost" case: the agent could not decode far enough to learn
        // which response it was. That is exactly the ack the window most needs.
        assert!(ack_matches(&ack("r-1", "", "lost"), "r-1", "p-1"));
    }

    #[test]
    fn ack_with_no_usable_id_matches_nothing() {
        assert!(!ack_matches(&ack("", "", "lost"), "r-1", "p-1"));
        assert!(!ack_matches(&ack("r-2", "", "lost"), "r-1", "p-1"));
    }

    #[test]
    fn ack_registry_delivers_once_and_forgets() {
        let waiters = AckWaiters::default();
        let mut rx = waiters.register("r-1", "p-1");

        waiters.deliver(ack("r-1", "p-1", "received"));
        assert_eq!(rx.try_recv().unwrap().status, "received");
        assert_eq!(waiters.0.lock().unwrap().len(), 0, "a delivered waiter must be dropped");

        // A duplicate ack must not panic or resurrect anything.
        waiters.deliver(ack("r-1", "p-1", "received"));
    }

    #[test]
    fn ack_registry_routes_to_the_right_concurrent_submission() {
        let waiters = AckWaiters::default();
        let mut first = waiters.register("r-1", "p-1");
        let mut second = waiters.register("r-2", "p-2");

        waiters.deliver(ack("r-2", "p-2", "lost"));

        assert_eq!(second.try_recv().unwrap().status, "lost");
        assert!(first.try_recv().is_err(), "the unrelated submission must still be waiting");
        assert_eq!(waiters.0.lock().unwrap().len(), 1);
    }

    #[test]
    fn ack_registry_forget_removes_a_timed_out_submission() {
        let waiters = AckWaiters::default();
        let _rx = waiters.register("r-1", "p-1");
        waiters.forget("p-1");

        assert_eq!(waiters.0.lock().unwrap().len(), 0);
        waiters.deliver(ack("r-1", "p-1", "received")); // must not panic
    }

    #[tokio::test]
    async fn attachment_upload_refuses_an_oversized_x_message_before_calling_ntfy() {
        // Overflow is answered by nginx with HTML, not ntfy's JSON envelope, so
        // it must be caught here with a name rather than parsed out of a 400.
        let mut response: PlanReviewResponseMessage =
            serde_json::from_str(r#"{"type":"plan_review_response","reviewId":"r-1"}"#).unwrap();
        response.snapshot_hash = "x".repeat(X_MESSAGE_MAX_BYTES);

        let config = HitlConfig {
            ntfy_url: "http://127.0.0.1:1".to_string(), // must never be reached
            topic_id: "t".to_string(),
            ..HitlConfig::default()
        };

        let err = publish_review_response(&config, &response, Some("cipher"), false)
            .await
            .unwrap_err()
            .to_string();

        assert!(err.contains("X-Message budget"), "{err}");
    }
}
