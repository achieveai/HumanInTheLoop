//! Catching up on what happened while the Inbox was closed.
//!
//! The archivist (spec §11) holds the log forever and serves it over
//! `GET /events?since=<seq>` as NDJSON on `127.0.0.1`. The Inbox asks it once
//! at startup for everything past its own high-water mark.
//!
//! **It is an optimization, not a dependency.** Every failure in this module
//! is logged and swallowed: with the archivist stopped the Inbox still works,
//! it simply cannot see further back than ntfy's own cache window — which the
//! subscribe loop replays on connect anyway.

use hitl_store::Store;
use hitl_transport::ntfy::subscribe::NtfyEvent;
use serde::Deserialize;

/// Must match `hitl_archivist::http::DEFAULT_PORT`. Not imported from it: the
/// Inbox does not depend on the archivist crate, and taking a dependency on a
/// binary to learn a port number would be the wrong direction entirely.
pub const DEFAULT_ARCHIVIST_PORT: u16 = 8737;

/// Loopback only, matching the server's own bind address. An archivist on
/// another host is not a supported configuration — see the security note on
/// `hitl_archivist::http`.
pub fn archivist_base() -> String {
    let port = std::env::var("HITL_ARCHIVIST_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(DEFAULT_ARCHIVIST_PORT);
    format!("http://127.0.0.1:{port}")
}

/// One line of the archivist's NDJSON.
///
/// Only the three fields ingest actually needs. `type`, `messageId` and
/// `subjectId` are on the wire too, but `Store::append` re-derives all three
/// from the payload — reading them here would let a stale archivist's idea of
/// what a message is about override this build's.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Line {
    ntfy_id: String,
    ntfy_time: u64,
    payload: String,
}

/// Parse an NDJSON backfill body into events ready to append.
///
/// A line that does not parse is skipped rather than failing the batch: NDJSON
/// exists here precisely so a truncated response costs the caller its last line
/// instead of the whole reply.
pub fn parse_ndjson(body: &str) -> Vec<(NtfyEvent, String)> {
    body.lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| match serde_json::from_str::<Line>(line) {
            Ok(parsed) => Some((
                NtfyEvent {
                    id: parsed.ntfy_id,
                    time: parsed.ntfy_time,
                    ..Default::default()
                },
                parsed.payload,
            )),
            Err(e) => {
                log::warn!("skipping an unparseable backfill line: {e}");
                None
            }
        })
        .collect()
}

/// Append a parsed backfill batch. Returns how many lines were offered.
///
/// `Store::append` is idempotent on ntfy id, so re-ingesting an overlap — the
/// ordinary case, since the cursor is inclusive of nothing and ntfy replays its
/// window too — adds nothing.
pub fn ingest(store: &Store, batch: &[(NtfyEvent, String)]) -> usize {
    let mut ingested = 0;
    for (event, payload) in batch {
        match store.append(event, payload) {
            Ok(_) => ingested += 1,
            Err(e) => log::warn!("could not record backfilled event {}: {e}", event.id),
        }
    }
    ingested
}

/// Ask the archivist for everything after `since`.
pub async fn fetch(base: &str, since: i64) -> Result<String, String> {
    let url = format!("{base}/events?since={since}");
    let response = reqwest::Client::new()
        .get(&url)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("archivist unreachable at {url}: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("archivist answered {} for {url}", response.status()));
    }
    response
        .text()
        .await
        .map_err(|e| format!("could not read the backfill body: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const LINE: &str = r#"{"seq":7,"ntfyId":"ntfy-1","ntfyTime":1786504000,"messageId":"q-1","type":"question","subjectId":"q-1","payload":"{\"type\":\"question\",\"messageId\":\"q-1\",\"question\":\"?\"}"}"#;

    #[test]
    fn a_backfill_line_becomes_an_appendable_event() {
        let parsed = parse_ndjson(LINE);

        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].0.id, "ntfy-1");
        assert_eq!(parsed[0].0.time, 1_786_504_000);
        assert!(parsed[0].1.contains("\"messageId\":\"q-1\""));
    }

    #[test]
    fn the_payload_survives_the_round_trip_byte_for_byte() {
        // The archivist keeps `payload` a string precisely so a consumer gets
        // back the bytes it was given; re-parsing it here would undo that.
        let store = Store::open_in_memory().unwrap();
        ingest(&store, &parse_ndjson(LINE));

        let events = store.events_for("q-1").unwrap();
        assert_eq!(events[0].payload, r#"{"type":"question","messageId":"q-1","question":"?"}"#);
    }

    #[test]
    fn ingest_re_derives_the_subject_rather_than_trusting_the_line() {
        let store = Store::open_in_memory().unwrap();
        ingest(&store, &parse_ndjson(LINE));

        assert_eq!(store.events_for("q-1").unwrap().len(), 1);
        assert_eq!(store.count_events().unwrap(), 1);
    }

    #[test]
    fn a_truncated_last_line_costs_only_that_line() {
        let body = format!("{LINE}\n{{\"ntfyId\":\"ntfy-2\",\"ntfyTi");
        assert_eq!(parse_ndjson(&body).len(), 1);
    }

    #[test]
    fn blank_lines_and_an_empty_body_are_not_events() {
        assert!(parse_ndjson("").is_empty());
        assert!(parse_ndjson("\n\n  \n").is_empty());
        assert_eq!(parse_ndjson(&format!("\n{LINE}\n\n")).len(), 1);
    }

    #[test]
    fn re_ingesting_the_same_backfill_adds_nothing() {
        // The cursor and ntfy's own replay overlap constantly, so this is the
        // ordinary path rather than an edge case.
        let store = Store::open_in_memory().unwrap();
        let batch = parse_ndjson(LINE);

        ingest(&store, &batch);
        ingest(&store, &batch);

        assert_eq!(store.count_events().unwrap(), 1, "ntfy_id is UNIQUE");
    }

    #[test]
    fn the_archivist_is_only_ever_addressed_on_loopback() {
        // The log holds every question and every plan from every agent, in the
        // clear, with no authentication anywhere in the design. Reaching for it
        // on any other host would be reaching for someone else's mail.
        assert!(archivist_base().starts_with("http://127.0.0.1:"));
    }
}
