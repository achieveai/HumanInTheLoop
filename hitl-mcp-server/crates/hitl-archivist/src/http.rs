//! Backfill over HTTP, on the loopback interface and nowhere else.
//!
//! The event log holds every question, every plan and every answer from every
//! agent on this machine, in the clear (spec §11). Binding it to `0.0.0.0`
//! would publish all of that to anyone on the same coffee-shop Wi-Fi, with no
//! authentication anywhere in the design to stop them — the design has none
//! precisely *because* it is loopback-only. So the bind address is a security
//! boundary, not a default, and [`tests::the_backfill_socket_is_loopback_only`]
//! is what keeps it one.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use hitl_store::{BodyStatus, Event};
use serde::Deserialize;

use crate::archive::{Archive, BodyLookup, DEFAULT_BACKFILL_LIMIT};

/// Default backfill port. Arbitrary, in the IANA dynamic range, and only ever
/// reachable from this machine.
pub const DEFAULT_PORT: u16 = 8737;

/// The only address this server may be given.
///
/// A function rather than a constant so there is exactly one place a future
/// change would have to happen, and one place a test can pin.
pub fn bind_addr(port: u16) -> SocketAddr {
    SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port)
}

/// Ceiling on one batch status request, matching the backfill's.
pub const MAX_STATUS_BATCH: usize = 1000;

pub fn router(archive: Arc<Archive>) -> Router {
    Router::new()
        .route("/events", get(events))
        .route("/bodies", get(body_statuses))
        // axum 0.8 spells a path parameter `{name}`. The 0.7 `:name` form is
        // rejected at router construction, so getting this wrong takes the
        // whole server down at startup rather than breaking one route.
        .route("/bodies/{content_hash}", get(body))
        .route("/health", get(health))
        .with_state(archive)
}

#[derive(Debug, Deserialize)]
pub struct Since {
    /// Local ingest sequence the caller already holds. Absent means "from the
    /// beginning", which is what a client with an empty store wants.
    #[serde(default)]
    since: i64,
    #[serde(default)]
    limit: Option<usize>,
}

async fn events(State(archive): State<Arc<Archive>>, Query(q): Query<Since>) -> Response {
    let limit = q.limit.unwrap_or(DEFAULT_BACKFILL_LIMIT).min(DEFAULT_BACKFILL_LIMIT);

    match archive.events_since(q.since, limit) {
        Ok(events) => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "application/x-ndjson")],
            ndjson(&events),
        )
            .into_response(),
        Err(e) => {
            log::error!("backfill failed: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, e).into_response()
        }
    }
}

/// One body, by the hash the message claimed.
///
/// This endpoint is the reason capturing bodies is worth anything. The Inbox
/// subscribes to ntfy itself, so for *live* messages it needs nothing from us —
/// but on backfill it receives history whose attachments ntfy deleted hours or
/// weeks ago, and there is no other copy anywhere. Without this route the
/// archivist would keep bodies forever that nothing could ever read.
///
/// # Buffered, not streamed
///
/// The bytes are read whole from SQLite and handed to axum whole, so peak
/// memory is about twice one body. That is a deliberate trade at these sizes:
/// a payload only becomes an attachment above 2 KB of ciphertext, and ntfy caps
/// attachments server-side well below anything worth streaming. Streaming would
/// mean `rusqlite`'s incremental blob API and holding the connection open
/// across the response — a lock held for as long as a slow reader takes, on the
/// same `Mutex` every ingest needs. Blocking ingest to save memory would trade
/// the cheap resource for the irreplaceable one.
///
/// If a body ever did exceed what memory allows, the allocation fails and the
/// process aborts rather than returning an error — `Vec` cannot signal that.
/// The upgrade path is `Connection::blob_open`, and the size at which it starts
/// to matter is set by ntfy's `attachment-file-size-limit`, not by us.
async fn body(State(archive): State<Arc<Archive>>, Path(content_hash): Path<String>) -> Response {
    match archive.look_up_body(&content_hash) {
        BodyLookup::Found(bytes) => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "application/octet-stream")],
            bytes,
        )
            .into_response(),

        // The 404 carries *why*, so a caller learns it in the same round trip
        // it would have spent finding out that the body is absent.
        BodyLookup::Missing(status) => (
            StatusCode::NOT_FOUND,
            [(header::CONTENT_TYPE, "application/json")],
            status_line(&content_hash, &status),
        )
            .into_response(),

        BodyLookup::Unavailable(e) => {
            log::error!("could not look up body {content_hash}: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, e).into_response()
        }
    }
}

/// Why each of many bodies is or is not available.
///
/// The list pane draws one row per message and needs a verdict for each. One
/// request per row would be an N+1 over HTTP on the first screen that renders.
async fn body_statuses(
    State(archive): State<Arc<Archive>>,
    Query(q): Query<Hashes>,
) -> Response {
    let hashes: Vec<&str> = q
        .hashes
        .split(',')
        .map(str::trim)
        .filter(|h| !h.is_empty())
        .take(MAX_STATUS_BATCH)
        .collect();

    match archive.body_statuses(&hashes) {
        Ok(statuses) => {
            let mut out = String::new();
            for (hash, status) in &statuses {
                out.push_str(&status_line(hash, status));
                out.push('\n');
            }
            (
                StatusCode::OK,
                [(header::CONTENT_TYPE, "application/x-ndjson")],
                out,
            )
                .into_response()
        }
        Err(e) => {
            log::error!("body status batch failed: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, e).into_response()
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct Hashes {
    /// Comma-separated. Safe as a separator because a content hash is hex.
    #[serde(default)]
    hashes: String,
}

/// One body's verdict as JSON.
///
/// `status` is a closed vocabulary a client can branch on; `detail` is prose
/// for a human and must never be parsed. `unknown` carries the raw `reason`
/// from a newer build rather than being flattened into one of today's cases.
fn status_line(content_hash: &str, status: &BodyStatus) -> String {
    let mut json = serde_json::json!({ "contentHash": content_hash });
    let object = json.as_object_mut().expect("just built as an object");

    let (name, detail, at) = match status {
        BodyStatus::Verified => ("verified", None, None),
        BodyStatus::Unattempted => ("unattempted", None, None),
        BodyStatus::Corrupt { actual_hash, detail, at } => {
            object.insert("actualHash".into(), serde_json::json!(actual_hash));
            ("corrupt", detail.as_deref(), Some(*at))
        }
        BodyStatus::Gone { detail, at } => ("gone", detail.as_deref(), Some(*at)),
        BodyStatus::Undecryptable { detail, at } => ("undecryptable", detail.as_deref(), Some(*at)),
        BodyStatus::Unknown { reason, detail, at } => {
            object.insert("reason".into(), serde_json::json!(reason));
            ("unknown", detail.as_deref(), Some(*at))
        }
    };

    object.insert("status".into(), serde_json::json!(name));
    if let Some(detail) = detail {
        object.insert("detail".into(), serde_json::json!(detail));
    }
    if let Some(at) = at {
        object.insert("at".into(), serde_json::json!(at));
    }
    json.to_string()
}

async fn health(State(archive): State<Arc<Archive>>) -> Response {
    let (events_recorded, bodies_stored, body_failures) = archive.stats.snapshot();
    let body = serde_json::json!({
        "eventsRecorded": events_recorded,
        "bodiesStored": bodies_stored,
        "bodyFailures": body_failures,
        "eventsHeld": archive.count_events().unwrap_or(-1),
    });

    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        body.to_string(),
    )
        .into_response()
}

/// One JSON object per line, in ingest order.
///
/// NDJSON rather than a JSON array so a consumer can stream it and stop
/// wherever it likes, and so a truncated response costs the caller the last
/// line rather than the whole reply.
pub fn ndjson(events: &[Event]) -> String {
    let mut out = String::new();
    for event in events {
        out.push_str(&event_line(event));
        out.push('\n');
    }
    out
}

/// The wire shape of one archived event.
///
/// `payload` stays a **string**, verbatim, rather than being re-parsed into
/// JSON and re-serialized: the log's promise is that it holds what arrived, and
/// a round-trip through `serde_json::Value` silently reorders keys and rewrites
/// number formatting. A consumer re-appending these to its own store has to get
/// back exactly the bytes we were given.
fn event_line(event: &Event) -> String {
    serde_json::json!({
        "seq": event.seq,
        "ntfyId": event.ntfy_id,
        "ntfyTime": event.ntfy_time,
        "messageId": event.message_id,
        "type": event.msg_type,
        "subjectId": event.subject_id,
        "payload": event.payload,
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    use hitl_transport::ntfy::subscribe::NtfyEvent;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    fn archive_with(count: usize) -> Arc<Archive> {
        let archive = Arc::new(Archive::in_memory().unwrap());
        for i in 1..=count {
            let event = NtfyEvent {
                id: format!("ntfy-{i}"),
                time: 1_786_504_000 + i as u64,
                ..Default::default()
            };
            archive
                .record(
                    &event,
                    &format!(r#"{{"type":"question","messageId":"q-{i}","question":"?"}}"#),
                )
                .unwrap();
        }
        archive
    }

    // --- The bind address is the security boundary ---

    #[test]
    fn the_bind_address_is_loopback_and_not_a_wildcard() {
        let addr = bind_addr(DEFAULT_PORT);

        assert_eq!(addr.ip(), IpAddr::V4(Ipv4Addr::LOCALHOST));
        assert!(addr.ip().is_loopback(), "the log must not leave this machine");
        assert!(
            !addr.ip().is_unspecified(),
            "0.0.0.0 would publish every question, plan and answer to the local network"
        );
        assert_eq!(addr.port(), DEFAULT_PORT);
    }

    #[tokio::test]
    async fn the_backfill_socket_is_loopback_only() {
        // Not a restatement of the test above: this asserts what the kernel
        // actually bound, so a future change that builds the address correctly
        // and then binds something else still fails here.
        let listener = TcpListener::bind(bind_addr(0)).await.unwrap();
        let bound = listener.local_addr().unwrap();

        assert!(bound.ip().is_loopback(), "bound to {bound}");
        assert!(!bound.ip().is_unspecified(), "bound to {bound}");
    }

    // --- ?since= ---

    #[test]
    fn ndjson_is_one_line_per_event_in_order() {
        let archive = archive_with(3);
        let body = ndjson(&archive.events_since(0, 100).unwrap());

        let lines: Vec<_> = body.lines().collect();
        assert_eq!(lines.len(), 3);
        assert!(body.ends_with('\n'), "every line must be terminated");

        let ids: Vec<String> = lines
            .iter()
            .map(|l| {
                serde_json::from_str::<serde_json::Value>(l).unwrap()["ntfyId"]
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect();
        assert_eq!(ids, vec!["ntfy-1", "ntfy-2", "ntfy-3"]);
    }

    #[test]
    fn an_ndjson_line_carries_everything_needed_to_re_append_it() {
        let archive = archive_with(1);
        let events = archive.events_since(0, 100).unwrap();
        let line: serde_json::Value = serde_json::from_str(ndjson(&events).trim()).unwrap();

        assert_eq!(line["seq"], events[0].seq);
        assert_eq!(line["ntfyId"], "ntfy-1");
        assert_eq!(line["ntfyTime"], 1_786_504_001u64);
        assert_eq!(line["messageId"], "q-1");
        assert_eq!(line["type"], "question");
        assert_eq!(line["subjectId"], "q-1");
        assert_eq!(
            line["payload"].as_str().unwrap(),
            events[0].payload,
            "the payload must survive as the exact string that arrived"
        );
    }

    #[test]
    fn an_empty_backfill_is_an_empty_body_rather_than_an_error() {
        let archive = archive_with(0);
        assert_eq!(ndjson(&archive.events_since(0, 100).unwrap()), "");
    }

    /// A bare HTTP/1.1 GET over loopback, so the route is exercised end to end
    /// without adding an HTTP client dependency for one assertion.
    async fn get(addr: SocketAddr, path: &str) -> String {
        let mut stream = TcpStream::connect(addr).await.unwrap();
        stream
            .write_all(
                format!("GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
                    .as_bytes(),
            )
            .await
            .unwrap();

        let mut raw = String::new();
        stream.read_to_string(&mut raw).await.unwrap();
        raw
    }

    async fn serve(archive: Arc<Archive>) -> SocketAddr {
        let listener = TcpListener::bind(bind_addr(0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, router(archive)).await.unwrap();
        });
        addr
    }

    #[tokio::test]
    async fn since_returns_exactly_the_events_after_it_in_order() {
        let archive = archive_with(4);
        let seqs: Vec<i64> = archive.events_since(0, 100).unwrap().iter().map(|e| e.seq).collect();
        let addr = serve(archive).await;

        let response = get(addr, &format!("/events?since={}", seqs[1])).await;

        assert!(response.starts_with("HTTP/1.1 200 OK"), "{response}");
        assert!(
            response.contains("application/x-ndjson"),
            "the content type must say what the body is: {response}"
        );

        let body = response.split("\r\n\r\n").nth(1).unwrap_or_default();
        let ids: Vec<String> = body
            .lines()
            .filter(|l| l.starts_with('{'))
            .map(|l| serde_json::from_str::<serde_json::Value>(l).unwrap()["ntfyId"].to_string())
            .collect();

        assert_eq!(ids, vec!["\"ntfy-3\"", "\"ntfy-4\""]);
    }

    #[tokio::test]
    async fn since_at_the_head_returns_nothing_and_since_absent_returns_everything() {
        let archive = archive_with(3);
        let last = archive.events_since(0, 100).unwrap().last().unwrap().seq;
        let addr = serve(archive).await;

        let at_head = get(addr, &format!("/events?since={last}")).await;
        let body = at_head.split("\r\n\r\n").nth(1).unwrap_or_default();
        assert!(
            body.lines().all(|l| !l.starts_with('{')),
            "nothing is newer than the head: {at_head}"
        );

        let from_start = get(addr, "/events").await;
        let body = from_start.split("\r\n\r\n").nth(1).unwrap_or_default();
        assert_eq!(
            body.lines().filter(|l| l.starts_with('{')).count(),
            3,
            "no ?since= means from the beginning"
        );
    }

    // --- Serving bodies back out (spec 11) ---

    /// The same bare GET, but without assuming the response is UTF-8. A body is
    /// opaque bytes, and a helper that decodes them would hide the one bug this
    /// endpoint can have.
    async fn get_raw(addr: SocketAddr, path: &str) -> (String, Vec<u8>) {
        let mut stream = TcpStream::connect(addr).await.unwrap();
        stream
            .write_all(
                format!("GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
                    .as_bytes(),
            )
            .await
            .unwrap();

        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).await.unwrap();

        let split = raw
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .expect("a response must have headers");
        let headers = String::from_utf8_lossy(&raw[..split]).to_string();
        (headers, raw[split + 4..].to_vec())
    }

    #[tokio::test]
    async fn a_stored_body_comes_back_byte_for_byte() {
        // The archivist's whole claim is that it still holds bodies ntfy has
        // deleted. A body that comes back altered is worse than one that is
        // missing: the hash it is keyed by no longer verifies, and the reader
        // cannot tell whether the plan or the transport is at fault.
        let archive = archive_with(0);
        let bytes: Vec<u8> = (0u8..=255).cycle().take(5000).collect();
        assert!(String::from_utf8(bytes.clone()).is_err(), "must not be valid UTF-8");
        archive.put_body_for_test("sha-plan", &bytes);
        let addr = serve(archive).await;

        let (headers, body) = get_raw(addr, "/bodies/sha-plan").await;

        assert!(headers.starts_with("HTTP/1.1 200 OK"), "{headers}");
        assert!(headers.contains("application/octet-stream"), "{headers}");
        assert_eq!(body, bytes, "the bytes must survive the round trip exactly");
    }

    #[tokio::test]
    async fn a_body_never_seen_404s_and_says_it_was_never_attempted() {
        let addr = serve(archive_with(0)).await;

        let (headers, body) = get_raw(addr, "/bodies/sha-nothing").await;

        assert!(headers.starts_with("HTTP/1.1 404"), "{headers}");
        assert!(headers.contains("application/json"), "{headers}");
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["status"], "unattempted");
        assert_eq!(json["contentHash"], "sha-nothing");
    }

    #[tokio::test]
    async fn a_404_says_why_the_body_is_missing_rather_than_only_that_it_is() {
        // The point of the failure table, carried across the process boundary.
        // "Corrupt" and "still coming" call for opposite reactions, and a bare
        // 404 gives the Inbox no way to tell them apart.
        let archive = archive_with(0);
        archive.note_gone("sha-expired", "ntfy-1", "ntfy dropped the attachment");
        let addr = serve(archive).await;

        let (headers, body) = get_raw(addr, "/bodies/sha-expired").await;

        assert!(headers.starts_with("HTTP/1.1 404"), "{headers}");
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["status"], "gone");
        assert_eq!(json["detail"], "ntfy dropped the attachment");
        assert!(json["at"].is_i64(), "and when we found out");
    }

    #[tokio::test]
    async fn a_corrupt_body_404s_and_names_where_the_bytes_were_quarantined() {
        let archive = archive_with(0);
        {
            let encoded = hitl_transport::payload::encode_payload(
                &hitl_transport::types::PlanReviewBody {
                    content: "# Plan\n".to_string(),
                    diff: String::new(),
                },
                None,
            )
            .unwrap();
            archive.capture_body(&"0".repeat(64), &encoded.cipher, None, Some("ntfy-1"));
        }
        let addr = serve(archive).await;

        let (headers, body) = get_raw(addr, &format!("/bodies/{}", "0".repeat(64))).await;

        assert!(headers.starts_with("HTTP/1.1 404"), "{headers}");
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["status"], "corrupt");
        assert!(
            json["actualHash"].as_str().is_some_and(|h| h.len() == 64),
            "diagnosis needs where the bytes went: {json}"
        );
    }

    #[tokio::test]
    async fn many_statuses_come_back_in_one_request_in_the_order_asked() {
        // Without this the list pane makes one request per row.
        let archive = archive_with(0);
        archive.put_body_for_test("sha-held", b"plan");
        archive.note_gone("sha-gone", "ntfy-1", "expired");
        let addr = serve(archive).await;

        let (headers, body) = get_raw(addr, "/bodies?hashes=sha-gone,sha-held,sha-never").await;

        assert!(headers.starts_with("HTTP/1.1 200 OK"), "{headers}");
        assert!(headers.contains("application/x-ndjson"), "same discipline as /events");

        let lines: Vec<serde_json::Value> = String::from_utf8(body)
            .unwrap()
            .lines()
            .filter(|l| l.starts_with('{'))
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();

        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0]["status"], "gone");
        assert_eq!(lines[1]["status"], "verified");
        assert_eq!(lines[2]["status"], "unattempted");
        assert_eq!(lines[1]["contentHash"], "sha-held", "order must match the request");
    }

    #[tokio::test]
    async fn asking_for_no_hashes_is_an_empty_answer_rather_than_an_error() {
        let addr = serve(archive_with(0)).await;

        let (headers, body) = get_raw(addr, "/bodies?hashes=").await;

        assert!(headers.starts_with("HTTP/1.1 200 OK"), "{headers}");
        assert!(!String::from_utf8(body).unwrap().contains('{'));
    }

    #[tokio::test]
    async fn bodies_are_served_on_the_loopback_socket_and_no_other() {
        // The bind is a security boundary and these routes widen what is behind
        // it from "events" to "every plan body in the clear". Same assertion as
        // the backfill's, restated against the socket that now serves bodies.
        let listener = TcpListener::bind(bind_addr(0)).await.unwrap();
        let bound = listener.local_addr().unwrap();
        assert!(bound.ip().is_loopback(), "bound to {bound}");
        assert!(!bound.ip().is_unspecified(), "bound to {bound}");

        let archive = archive_with(0);
        archive.put_body_for_test("sha-plan", b"secret plan");
        tokio::spawn(async move {
            axum::serve(listener, router(archive)).await.unwrap();
        });

        let (headers, body) = get_raw(bound, "/bodies/sha-plan").await;
        assert!(headers.starts_with("HTTP/1.1 200 OK"), "{headers}");
        assert_eq!(body, b"secret plan");
    }

    #[test]
    fn a_status_from_a_newer_build_keeps_its_reason_on_the_wire() {
        // Flattening it into `gone` would tell the Inbox a recoverable body is
        // dead; flattening it into `unattempted` would promise one that is not
        // coming.
        let line = status_line(
            "sha-1",
            &BodyStatus::Unknown {
                reason: "quarantined_by_policy".to_string(),
                detail: Some("from v3".to_string()),
                at: 99,
            },
        );
        let json: serde_json::Value = serde_json::from_str(&line).unwrap();

        assert_eq!(json["status"], "unknown");
        assert_eq!(json["reason"], "quarantined_by_policy");
        assert_eq!(json["detail"], "from v3");
    }

    #[tokio::test]
    async fn health_reports_what_has_actually_been_recorded() {
        let archive = archive_with(2);
        let addr = serve(archive).await;

        let response = get(addr, "/health").await;
        let body = response.split("\r\n\r\n").nth(1).unwrap_or_default();
        let stats: serde_json::Value = serde_json::from_str(body.trim()).unwrap();

        assert_eq!(stats["eventsRecorded"], 2);
        assert_eq!(stats["eventsHeld"], 2);
        assert_eq!(stats["bodyFailures"], 0);
    }
}
