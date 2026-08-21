use std::collections::{HashSet, VecDeque};

use futures_util::StreamExt;

use crate::chunking::ChunkAssembler;
use crate::config::load_config;
use crate::ntfy::dispatch::{
    decrypt_and_reassemble_cache, dispatch_message, extract_answered_ids, resolve_chunked_message,
    try_decrypt, Origin,
};
use crate::ntfy::http::{fetch_cached_body, http_client, STREAM_READ_TIMEOUT};
use crate::ntfy::NtfySink;
use crate::status::ConnectionStatus;
use crate::types::{AttachmentRef, HitlConfig};

/// How many recently-dispatched message IDs to remember for reconnect de-dup.
/// A reconnect replays at most one ntfy cache window, so this is generous.
const SEEN_ID_CAPACITY: usize = 512;

/// One decoded ntfy event line.
pub struct NtfyEvent {
    pub message: String,
    pub attachment: Option<AttachmentRef>,
    /// Unix seconds, as assigned by ntfy. 0 when the event omitted it.
    pub time: u64,
}

/// Pull the message body, ntfy's own attachment metadata, and the event time
/// off one raw event line.
///
/// All three readers previously kept only `message` and discarded the rest of
/// the event, which left an attachment-backed payload with nowhere to arrive —
/// the attachment URL exists only on the ntfy envelope, never inside our own
/// message, because it is assigned by the PUT. `time` is what lets a reconnect
/// resume from the last event actually processed instead of replaying the whole
/// session from the timestamp the client happened to start at.
pub fn parse_ntfy_event(line: &str) -> Option<NtfyEvent> {
    let event: serde_json::Value = serde_json::from_str(line).ok()?;
    let message = event.get("message")?.as_str()?.to_string();

    let attachment = event
        .get("attachment")
        .and_then(|a| serde_json::from_value::<AttachmentRef>(a.clone()).ok())
        .filter(|a| !a.url.is_empty());

    let time = event.get("time").and_then(|t| t.as_u64()).unwrap_or(0);

    Some(NtfyEvent {
        message,
        attachment,
        time,
    })
}

/// Bounded record of the message IDs already dispatched on this run.
///
/// `subscribe_live` had no de-dup at all — only the cache path filtered, via
/// `answered_ids`. Since a reconnect now resumes from the last processed event
/// time (and `since=` is inclusive), the boundary event arrives twice on every
/// reconnect. Without this, a blip re-pops a window the user already dealt with.
///
/// Bounded because a client stays up for weeks; the eviction order is insertion
/// order, which is the order ntfy delivers in.
pub struct SeenIds {
    order: VecDeque<String>,
    ids: HashSet<String>,
    capacity: usize,
}

impl SeenIds {
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            order: VecDeque::with_capacity(capacity),
            ids: HashSet::with_capacity(capacity),
            capacity,
        }
    }

    /// Record `id` and report whether it is new. An empty id is never recorded —
    /// `messageId` is `#[serde(default)]`, so a malformed message yields "", and
    /// suppressing every later one of those would be worse than a duplicate.
    pub fn insert(&mut self, id: &str) -> bool {
        if id.is_empty() {
            return true;
        }
        if !self.ids.insert(id.to_string()) {
            return false;
        }

        self.order.push_back(id.to_string());
        if self.order.len() > self.capacity {
            if let Some(evicted) = self.order.pop_front() {
                self.ids.remove(&evicted);
            }
        }
        true
    }
}

impl Default for SeenIds {
    fn default() -> Self {
        Self::with_capacity(SEEN_ID_CAPACITY)
    }
}

/// State that must survive a reconnect.
///
/// The chunk assembler used to be constructed inside `subscribe_live`, so any
/// blip midway through a chunk group silently discarded the fragments already
/// received and the group could never complete.
pub struct LiveState {
    assembler: ChunkAssembler,
    seen: SeenIds,
    /// When this client started subscribing. Monotonic, so it is unaffected by
    /// an NTP correction or a suspend/resume.
    started: std::time::Instant,
    /// Highest event time actually observed — **ntfy's clock, never ours**.
    /// `None` until an event arrives.
    last_event_ts: Option<u64>,
}

impl LiveState {
    /// The `since=` value for the next subscribe.
    fn since_param(&self) -> String {
        since_param(self.last_event_ts, self.started.elapsed().as_secs())
    }

    fn observe(&mut self, event_time: u64) {
        if event_time == 0 {
            return; // an event ntfy gave no time for tells us nothing
        }
        if self.last_event_ts.is_none_or(|ts| event_time > ts) {
            self.last_event_ts = Some(event_time);
        }
    }
}

/// How far before the subscription's start to resume from, covering the cache
/// poll that happens first.
const RESUME_MARGIN_SECS: u64 = 10;

/// Nothing older than the ntfy cache window is retrievable anyway.
const RESUME_MAX_SECS: u64 = 12 * 60 * 60;

/// Build the `since=` query value without ever mixing two clocks.
///
/// The old code seeded this from the **local** wall clock and then `max()`-ed
/// it against ntfy's **server** timestamps. A laptop running five minutes fast
/// pinned the value in the future permanently: every `max` kept the local seed,
/// and on the first reconnect ntfy was asked for messages newer than a time
/// that had not happened yet, so everything published during the disconnect was
/// never delivered. Invisible until exactly the moment it mattered.
///
/// So: once an event has been seen, resume from that event's own server
/// timestamp. Until then, hand ntfy a *relative* duration and let it resolve
/// against the only clock that matters — its own.
fn since_param(last_event_ts: Option<u64>, elapsed_secs: u64) -> String {
    match last_event_ts {
        Some(ts) => ts.to_string(),
        None => format!("{}s", (elapsed_secs + RESUME_MARGIN_SECS).min(RESUME_MAX_SECS)),
    }
}

/// Start listening to ntfy for incoming question messages.
/// First polls cached messages to find pending (unanswered) questions,
/// then subscribes to live messages going forward.
pub async fn subscribe_loop(sink: &impl NtfySink, status: &ConnectionStatus) {
    let config = match load_config() {
        Ok(c) => c,
        Err(e) => {
            log::error!("HITL config error: {}", e);
            return;
        }
    };

    let base_url = format!(
        "{}/{}",
        config.ntfy_url.trim_end_matches('/'),
        config.topic_id
    );

    // Monotonic, and started before the cache poll so the live subscription
    // covers the gap. Deliberately not a wall-clock timestamp: ntfy resolves
    // the relative `since` against its own clock, so ours never enters into it.
    let started = std::time::Instant::now();

    // Phase 1: Poll all cached messages once, then process
    log::info!("Fetching cached messages to find pending questions...");
    let cached_body = fetch_cached_body(&base_url).await;
    let answered_ids = extract_answered_ids(&cached_body, &config);
    log::info!("Found {} settled questions and reviews in cache", answered_ids.len());

    // One de-dup set for both phases. The cache replay and the live stream
    // overlap by design, so a question seen in the cache must not re-dispatch
    // the moment the subscription opens.
    let mut seen = SeenIds::with_capacity(SEEN_ID_CAPACITY);

    // Show any pending (unanswered) questions from cache
    show_pending_from_cache(sink, &config, &cached_body, &answered_ids, &mut seen).await;

    // Phase 2: Subscribe to live messages (from just before cache poll to avoid gaps)
    //
    // `since_ts` used to be captured once and reused verbatim on every
    // reconnect, so a blip during a multi-hour block re-fetched the whole
    // session's history — with no de-dup, re-popping windows the user had
    // already answered. State that has to survive a reconnect lives here now,
    // including the chunk assembler: it was constructed inside subscribe_live,
    // so a reconnect mid-group discarded the fragments already collected and
    // the group could never complete.
    let mut state = LiveState {
        assembler: ChunkAssembler::new(),
        seen,
        started,
        last_event_ts: None,
    };
    log::info!("Subscribing to live ntfy messages from {}", base_url);

    loop {
        let live_url = format!("{}/json?since={}", base_url, state.since_param());
        match subscribe_live(sink, status, &config, &live_url, &mut state).await {
            Ok(()) => log::warn!("ntfy stream ended, reconnecting in 5s..."),
            Err(e) => log::warn!("ntfy error: {}, reconnecting in 5s...", e),
        }
        sink.on_connected(false);
        status.mark_connected(false);
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    }
}

/// Show pending (unanswered) questions from the already-fetched cache body.
///
/// Routes through the same dispatch as live messages rather than keeping a
/// second, subtly-different type chain — the two used to disagree about which
/// types they recognized.
async fn show_pending_from_cache(
    sink: &impl NtfySink,
    config: &HitlConfig,
    body: &str,
    answered_ids: &HashSet<String>,
    seen: &mut SeenIds,
) {
    if body.is_empty() { return; }

    for (decrypted, was_encrypted, attachment) in decrypt_and_reassemble_cache(body, config) {
        dispatch_message(
            sink,
            config,
            &decrypted,
            was_encrypted,
            attachment,
            Origin::Cache { answered_ids, seen },
        )
        .await;
    }
}

/// Subscribe to live (new) messages from ntfy.
///
/// `state` outlives the call so a reconnect resumes rather than restarts.
async fn subscribe_live(
    sink: &impl NtfySink,
    status: &ConnectionStatus,
    config: &HitlConfig,
    url: &str,
    state: &mut LiveState,
) -> Result<(), Box<dyn std::error::Error>> {
    // No overall timeout: this request is meant to stay open. The read timeout
    // is what distinguishes a quiet connection from a dead one.
    let client = http_client(None, Some(STREAM_READ_TIMEOUT));
    let response = client
        .get(url)
        .header("Accept", "application/x-ndjson")
        .send()
        .await?;

    if !response.status().is_success() {
        return Err(format!("ntfy returned {}", response.status()).into());
    }

    sink.on_connected(true);
    status.mark_connected(true);

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(newline_pos) = buffer.find('\n') {
            let line = buffer[..newline_pos].trim().to_string();
            buffer = buffer[newline_pos + 1..].to_string();

            if line.is_empty() {
                continue;
            }

            if let Some(event) = parse_ntfy_event(&line) {
                // Advance before dispatching: a message that fails to decode is
                // still a message we do not want re-delivered on every retry.
                state.observe(event.time);
                sink.on_message();
                status.mark_message();

                if let Some((decrypted, was_encrypted)) = try_decrypt(&event.message, config) {
                    if let Some((final_body, final_encrypted)) = resolve_chunked_message(
                        &decrypted,
                        was_encrypted,
                        config,
                        &mut state.assembler,
                    ) {
                        dispatch_message(
                            sink,
                            config,
                            &final_body,
                            final_encrypted,
                            event.attachment,
                            Origin::Live {
                                seen: &mut state.seen,
                            },
                        )
                        .await;
                    }
                }
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Exact event shape returned by GET /{topic}/json, captured from ntfy.sh.
    const EVENT_WITH_ATTACHMENT: &str = r#"{"id":"abc","time":1786504137,"event":"message",
        "topic":"t","message":"{\"type\":\"plan_review\"}",
        "attachment":{"name":"qurRQchLV1Fb.bin","type":"application/octet-stream",
        "size":5000,"expires":1786514937,"url":"https://ntfy.sh/file/qurRQchLV1Fb.bin"}}"#;

    #[test]
    fn parse_ntfy_event_lifts_the_message_and_the_attachment() {
        let event = parse_ntfy_event(EVENT_WITH_ATTACHMENT).unwrap();

        assert_eq!(event.message, r#"{"type":"plan_review"}"#);
        assert_eq!(event.time, 1786504137);
        let att = event.attachment.expect("attachment metadata must survive the reader");
        assert_eq!(att.url, "https://ntfy.sh/file/qurRQchLV1Fb.bin");
        assert_eq!(att.name, "qurRQchLV1Fb.bin");
        assert_eq!(att.size, Some(5000));
        assert_eq!(att.expires, Some(1786514937));
    }

    #[test]
    fn parse_ntfy_event_yields_no_attachment_for_an_ordinary_message() {
        let line =
            r#"{"id":"abc","event":"message","topic":"t","message":"{\"type\":\"question\"}"}"#;

        let event = parse_ntfy_event(line).unwrap();
        assert_eq!(event.message, r#"{"type":"question"}"#);
        assert!(event.attachment.is_none());
        assert_eq!(event.time, 0, "a missing time must not look like a real one");
    }

    #[test]
    fn parse_ntfy_event_discards_attachment_metadata_with_no_url() {
        // Nothing can be fetched without a URL, so it must not look present.
        let line = r#"{"message":"{}","attachment":{"name":"x.bin","size":1}}"#;

        assert!(parse_ntfy_event(line).unwrap().attachment.is_none());
    }

    #[test]
    fn parse_ntfy_event_skips_events_that_carry_no_message() {
        // ntfy sends open and keepalive events on the same stream.
        assert!(parse_ntfy_event(r#"{"id":"abc","event":"keepalive","topic":"t"}"#).is_none());
        assert!(parse_ntfy_event("not json at all").is_none());
        assert!(parse_ntfy_event(r#"{"message":42}"#).is_none());
    }

    // --- Reconnect de-dup (W2.6 / C-14) ---

    #[test]
    fn seen_ids_reports_the_first_sighting_and_suppresses_the_rest() {
        let mut seen = SeenIds::with_capacity(8);

        assert!(seen.insert("msg-1"), "first sighting must dispatch");
        assert!(!seen.insert("msg-1"), "a reconnect replay must not dispatch");
        assert!(seen.insert("msg-2"));
    }

    #[test]
    fn seen_ids_never_suppresses_a_message_with_no_id() {
        // messageId is #[serde(default)], so a malformed message yields "".
        // Collapsing all of those into one would hide every later failure.
        let mut seen = SeenIds::with_capacity(8);

        assert!(seen.insert(""));
        assert!(seen.insert(""));
    }

    #[test]
    fn seen_ids_evicts_in_arrival_order_once_full() {
        let mut seen = SeenIds::with_capacity(2);
        seen.insert("a");
        seen.insert("b");
        seen.insert("c"); // evicts "a"

        assert!(seen.insert("a"), "the oldest id must have been evicted");
        assert!(!seen.insert("c"), "the newest ids must still be remembered");
        assert_eq!(seen.ids.len(), seen.order.len(), "the two views must not drift");
        assert!(seen.ids.len() <= 2, "the set must stay bounded");
    }

    #[test]
    fn seen_ids_reinsertion_does_not_duplicate_the_eviction_queue() {
        let mut seen = SeenIds::with_capacity(4);
        for _ in 0..10 {
            seen.insert("same");
        }

        assert_eq!(seen.order.len(), 1);
        assert_eq!(seen.ids.len(), 1);
    }

    // --- Resume point (never mixing two clocks) ---

    #[test]
    fn the_resume_point_never_mixes_the_local_clock_with_ntfys() {
        // Before any event, resume is a duration ntfy resolves against its own
        // clock — our wall clock never enters the request at all.
        assert_eq!(since_param(None, 0), "10s");
        assert_eq!(since_param(None, 5), "15s");

        // Once an event has arrived, resume from its own server timestamp.
        assert_eq!(since_param(Some(1_786_543_402), 9_999), "1786543402");
    }

    #[test]
    fn a_fast_local_clock_cannot_pin_the_resume_point_in_the_future() {
        // The defect: seeding from local wall-clock time and max()-ing against
        // server timestamps. A laptop five minutes fast kept its own seed
        // forever, so after a reconnect ntfy was asked for messages newer than
        // a moment that had not happened yet — and everything published during
        // the disconnect was never delivered.
        let mut state = LiveState {
            assembler: ChunkAssembler::new(),
            seen: SeenIds::with_capacity(4),
            started: std::time::Instant::now(),
            last_event_ts: None,
        };

        // Server time, five minutes "behind" a fast local clock.
        state.observe(1_786_543_000);
        assert_eq!(state.since_param(), "1786543000");

        // A later server event advances it; an earlier one does not rewind it.
        state.observe(1_786_543_402);
        assert_eq!(state.since_param(), "1786543402");
        state.observe(1_786_542_000);
        assert_eq!(state.since_param(), "1786543402");
    }

    #[test]
    fn an_event_with_no_time_leaves_the_resume_point_alone() {
        let mut state = LiveState {
            assembler: ChunkAssembler::new(),
            seen: SeenIds::with_capacity(4),
            started: std::time::Instant::now(),
            last_event_ts: None,
        };

        state.observe(0);
        assert!(state.last_event_ts.is_none(), "0 is absence, not an instant");
        assert!(state.since_param().ends_with('s'), "still relative");
    }

    #[test]
    fn a_long_disconnect_before_any_event_is_capped_at_the_cache_window() {
        // Nothing older than ntfy's cache is retrievable, so asking for a week
        // only makes the URL silly.
        assert_eq!(since_param(None, 7 * 24 * 3600), format!("{RESUME_MAX_SECS}s"));
    }
}
