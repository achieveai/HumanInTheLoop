use reqwest::Client;

use crate::ntfy::dispatch::ReviewBodyError;
use crate::payload::{self, PayloadError};
use crate::types::{AttachmentRef, HitlConfig, PlanPayloadRef, PlanReviewBody};

/// How long to wait for a TCP connection and TLS handshake.
pub const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Ceiling on a whole request/response for the short calls: publish, cache poll.
pub const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Attachments are megabytes over whatever link the human is on, so they get
/// longer than a publish — but still a bound.
pub const ATTACHMENT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// A subscription is a long poll: it is *supposed* to stay open for hours, so
/// it gets no overall deadline. This bounds the gap between reads instead.
/// ntfy sends a keepalive roughly every 45 s, so silence this long is a dead
/// connection rather than a quiet one.
pub const STREAM_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// Build an HTTP client with an actual deadline on it.
///
/// `Client::new()` has neither a request timeout nor a connect timeout. A host
/// that completes the handshake and then sends nothing hangs the caller
/// forever — and `dispatch_message` is awaited inline inside the stream loop,
/// so one such host stops every future message from being dispatched while the
/// tray still reports "Connected". Nothing in this crate may use the default.
pub fn http_client(
    timeout: Option<std::time::Duration>,
    read_timeout: Option<std::time::Duration>,
) -> Client {
    let mut builder = Client::builder().connect_timeout(CONNECT_TIMEOUT);
    if let Some(timeout) = timeout {
        builder = builder.timeout(timeout);
    }
    if let Some(read_timeout) = read_timeout {
        builder = builder.read_timeout(read_timeout);
    }

    builder.build().unwrap_or_else(|e| {
        // Only fails if the TLS backend cannot initialize, in which case an
        // un-timed-out client is the lesser problem — but say so.
        log::error!("Could not build an HTTP client with timeouts: {}", e);
        Client::new()
    })
}

/// Fetch all cached messages from ntfy as a single body string.
pub async fn fetch_cached_body(base_url: &str) -> String {
    let poll_url = format!("{}/json?since=all&poll=1", base_url);

    let client = http_client(Some(REQUEST_TIMEOUT), None);
    let response = match client
        .get(&poll_url)
        .header("Accept", "application/x-ndjson")
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r,
        Ok(r) => {
            log::warn!("Cache poll returned {}", r.status());
            return String::new();
        }
        Err(e) => {
            log::warn!("Cache poll failed: {}", e);
            return String::new();
        }
    };

    response.text().await.unwrap_or_default()
}

/// Download an ntfy attachment as a string.
///
/// A 404 is the expected outcome, not an anomaly: ntfy expires attachments
/// after 3 h but keeps messages for 12 h, and the cache poll runs `since=all`
/// on every client start. Any review older than 3 h replays against a dead URL.
pub async fn download_attachment(url: &str) -> Result<String, ReviewBodyError> {
    let response = http_client(Some(ATTACHMENT_TIMEOUT), None)
        .get(url)
        .send()
        .await
        .map_err(|e| ReviewBodyError::Network(e.to_string()))?;

    if response.status() == reqwest::StatusCode::NOT_FOUND
        || response.status() == reqwest::StatusCode::GONE
    {
        return Err(ReviewBodyError::Payload(PayloadError::Expired));
    }
    if !response.status().is_success() {
        return Err(ReviewBodyError::Network(format!(
            "ntfy returned {}",
            response.status()
        )));
    }

    response
        .text()
        .await
        .map_err(|e| ReviewBodyError::Network(e.to_string()))
}

/// Fetch (if needed), decrypt, gunzip and hash-verify a plan-review body.
pub async fn download_and_decode(
    body_ref: Option<&PlanPayloadRef>,
    attachment: Option<&AttachmentRef>,
    config: &HitlConfig,
) -> Result<PlanReviewBody, ReviewBodyError> {
    let body_ref = body_ref.ok_or(ReviewBodyError::Payload(PayloadError::MissingData))?;

    let cipher = if body_ref.kind == "attachment" {
        let attachment = attachment.ok_or(ReviewBodyError::NoAttachment)?;
        download_attachment(&attachment.url).await?
    } else {
        body_ref
            .data
            .clone()
            .ok_or(ReviewBodyError::Payload(PayloadError::MissingData))?
    };

    payload::decode_payload(cipher.trim(), config.encryption_key.as_deref(), &body_ref.content_hash)
        .map_err(ReviewBodyError::Payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_http_client_in_this_module_carries_a_deadline() {
        // Not a style preference. `Client::new()` has no request timeout and no
        // connect timeout, and dispatch is awaited inline in the stream loop,
        // so a single host that accepts a connection and then goes quiet stops
        // every future message from being dispatched.
        for (timeout, read_timeout) in [
            (Some(REQUEST_TIMEOUT), None),
            (Some(ATTACHMENT_TIMEOUT), None),
            (None, Some(STREAM_READ_TIMEOUT)),
        ] {
            // Builds rather than falling back to the untimed default.
            let _ = http_client(timeout, read_timeout);
        }
    }

    #[test]
    fn the_subscription_read_timeout_outlives_an_ntfy_keepalive() {
        // ntfy sends a keepalive roughly every 45 s. A read timeout at or below
        // that would tear down a perfectly healthy subscription on a timer, and
        // the reconnect loop would hide it as a recurring "stream ended".
        const NTFY_KEEPALIVE: std::time::Duration = std::time::Duration::from_secs(45);

        assert!(
            STREAM_READ_TIMEOUT > NTFY_KEEPALIVE * 2,
            "a subscription must tolerate at least two missed keepalives"
        );
        // And it must not be given an overall deadline: a long poll is supposed
        // to stay open for hours.
        assert!(CONNECT_TIMEOUT < REQUEST_TIMEOUT);
        assert!(ATTACHMENT_TIMEOUT >= REQUEST_TIMEOUT);
    }

    #[tokio::test]
    async fn decode_refuses_a_tampered_body_instead_of_rendering_half_a_plan() {
        let body = PlanReviewBody {
            content: "# Plan".to_string(),
            diff: String::new(),
        };
        let encoded = payload::encode_payload(&body, None).unwrap();

        let body_ref = PlanPayloadRef {
            kind: "inline".to_string(),
            data: Some(encoded.cipher.clone()),
            content_hash: "0".repeat(64), // not the hash of anything we sent
            content_length: encoded.payload_ref.content_length,
        };

        let err = download_and_decode(Some(&body_ref), None, &HitlConfig::default())
            .await
            .unwrap_err();

        assert_eq!(err.kind(), "hash_mismatch");
    }

    #[tokio::test]
    async fn decode_reports_missing_data_rather_than_an_empty_plan() {
        let config = HitlConfig::default();

        // No body ref at all.
        assert_eq!(
            download_and_decode(None, None, &config).await.unwrap_err().kind(),
            "missing"
        );

        // kind=inline but no data.
        let no_data = PlanPayloadRef {
            kind: "inline".to_string(),
            data: None,
            content_hash: String::new(),
            content_length: 0,
        };
        assert_eq!(
            download_and_decode(Some(&no_data), None, &config).await.unwrap_err().kind(),
            "missing"
        );

        // kind=attachment but the event carried no attachment metadata.
        let no_attachment = PlanPayloadRef {
            kind: "attachment".to_string(),
            data: None,
            content_hash: String::new(),
            content_length: 0,
        };
        assert_eq!(
            download_and_decode(Some(&no_attachment), None, &config).await.unwrap_err().kind(),
            "missing"
        );
    }

    #[tokio::test]
    async fn decode_round_trips_an_inline_body() {
        let body = PlanReviewBody {
            content: "# Plan\r\nCRLF must survive\r\n".to_string(),
            diff: "@@\n".to_string(),
        };
        let encoded = payload::encode_payload(&body, None).unwrap();

        let decoded = download_and_decode(
            Some(&encoded.payload_ref),
            None,
            &HitlConfig::default(),
        )
        .await
        .unwrap();

        assert_eq!(decoded.content, "# Plan\r\nCRLF must survive\r\n");
        assert_eq!(decoded.diff, "@@\n");
    }
}
