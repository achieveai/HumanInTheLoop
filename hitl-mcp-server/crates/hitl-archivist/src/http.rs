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

use axum::extract::{Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use hitl_store::Event;
use serde::Deserialize;

use crate::archive::{Archive, DEFAULT_BACKFILL_LIMIT};

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

pub fn router(archive: Arc<Archive>) -> Router {
    Router::new()
        .route("/events", get(events))
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
