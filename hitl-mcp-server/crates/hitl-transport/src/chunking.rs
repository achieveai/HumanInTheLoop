use std::collections::HashMap;
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};

use crate::types::ChunkMessage;

/// Incomplete groups older than this are dropped — matches the server's silent-loss
/// behavior for a single oversized/dropped message (no retry protocol).
#[cfg(not(test))]
const GROUP_TTL: Duration = Duration::from_secs(600);
#[cfg(test)]
const GROUP_TTL: Duration = Duration::from_millis(50);

/// base64 chars the server packs into each fragment's `data` field
/// (`server/src/chunking.ts` `CHUNK_DATA_SIZE`). Mirrored here only to express
/// what `MAX_CHUNKS` is worth in bytes.
#[cfg(test)]
const SERVER_CHUNK_DATA_SIZE: usize = 3000;

/// Upper bound on a group's fragment count.
///
/// `total` arrives over the wire and is fed straight to `vec![None; total]`, so
/// without a bound one malformed field is an allocation of `total * 24` bytes:
/// a large value aborts the process on allocation failure, and `usize::MAX`
/// panics on capacity overflow. Either kills `subscribe_loop`, and every later
/// message with it.
///
/// 512 fragments is ~1.5 MB of base64, ~1.1 MB of body — two orders of
/// magnitude past any real question, and a trivial allocation if a bogus
/// `total` does arrive.
const MAX_CHUNKS: usize = 512;

struct PendingGroup {
    parts: Vec<Option<String>>,
    first_seen: Instant,
}

/// Reassembles `ChunkMessage` fragments (fed in any order) back into the original
/// base64-encoded body they were split from.
pub struct ChunkAssembler {
    groups: HashMap<String, PendingGroup>,
}

impl ChunkAssembler {
    pub fn new() -> Self {
        Self {
            groups: HashMap::new(),
        }
    }

    /// Feed one fragment. Returns `Some(body)` once every fragment for its group
    /// has arrived (the group is removed at that point); otherwise `None`.
    ///
    /// Fragments whose header does not describe a group we could ever complete
    /// are dropped before any allocation happens.
    pub fn feed(&mut self, chunk: ChunkMessage) -> Option<String> {
        self.evict_stale();

        // `total == 0` would produce an empty `parts`, which `all()` reports as
        // complete vacuously — dispatching an empty body as if it were a
        // reassembled message.
        if chunk.total == 0 || chunk.total > MAX_CHUNKS || chunk.index >= chunk.total {
            log::warn!(
                "Ignoring chunk {} of group {}: index {} / total {} is not a fragment of any \
                 group we can assemble (max {})",
                chunk.message_id,
                chunk.group_id,
                chunk.index,
                chunk.total,
                MAX_CHUNKS
            );
            return None;
        }

        let group = self
            .groups
            .entry(chunk.group_id.clone())
            .or_insert_with(|| PendingGroup {
                parts: vec![None; chunk.total],
                first_seen: Instant::now(),
            });

        // A group's size is fixed by whichever fragment arrived first. The
        // server builds every fragment of a group in one pass, so a disagreeing
        // `total` means one of the two is wrong — and writing into a
        // wrongly-sized array would reassemble a corrupt body rather than let
        // the group expire.
        if chunk.total != group.parts.len() {
            log::warn!(
                "Ignoring chunk {} of group {}: claims total {} but the group was opened with {}",
                chunk.message_id,
                chunk.group_id,
                chunk.total,
                group.parts.len()
            );
            return None;
        }

        group.parts[chunk.index] = Some(chunk.data);

        let complete = group.parts.iter().all(|p| p.is_some());
        if !complete {
            return None;
        }

        let group = self.groups.remove(&chunk.group_id)?;
        let encoded: String = group.parts.into_iter().map(|p| p.unwrap()).collect();
        let bytes = BASE64.decode(&encoded).ok()?;
        String::from_utf8(bytes).ok()
    }

    fn evict_stale(&mut self) {
        let now = Instant::now();
        self.groups
            .retain(|_, g| now.duration_since(g.first_seen) < GROUP_TTL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(group_id: &str, index: usize, total: usize, data: &str) -> ChunkMessage {
        ChunkMessage {
            msg_type: "chunk".to_string(),
            message_id: format!("{}-chunk-{}", group_id, index),
            timestamp: 0,
            group_id: group_id.to_string(),
            index,
            total,
            data: data.to_string(),
        }
    }

    fn chunks_for(body: &str, group_id: &str, chunk_size: usize) -> Vec<ChunkMessage> {
        let encoded = BASE64.encode(body.as_bytes());
        let total = (encoded.len() + chunk_size - 1) / chunk_size;
        (0..total)
            .map(|i| {
                let start = i * chunk_size;
                let end = ((i + 1) * chunk_size).min(encoded.len());
                chunk(group_id, i, total, &encoded[start..end])
            })
            .collect()
    }

    #[test]
    fn reassembles_fragments_fed_in_order() {
        let body = "hello world, this is a reassembled body";
        let fragments = chunks_for(body, "group-1", 8);
        assert!(fragments.len() > 1);

        let mut assembler = ChunkAssembler::new();
        let mut result = None;
        for f in fragments {
            result = assembler.feed(f);
        }

        assert_eq!(result, Some(body.to_string()));
    }

    #[test]
    fn reassembles_fragments_fed_out_of_order() {
        let body = "out of order reassembly must still work correctly";
        let mut fragments = chunks_for(body, "group-2", 8);
        assert!(fragments.len() > 2);
        fragments.reverse();

        let mut assembler = ChunkAssembler::new();
        let mut result = None;
        for f in fragments {
            result = assembler.feed(f);
        }

        assert_eq!(result, Some(body.to_string()));
    }

    #[test]
    fn duplicate_index_overwrites_previous_value() {
        let body = "duplicate index handling";
        let fragments = chunks_for(body, "group-3", 8);
        assert!(fragments.len() > 1);

        let mut assembler = ChunkAssembler::new();
        // Feed fragment 0 twice with stale data before feeding the rest — the
        // second feed should win.
        let stale = chunk("group-3", 0, fragments.len(), "XXXXXXXX");
        assembler.feed(stale);

        let mut result = None;
        for f in fragments {
            result = assembler.feed(f);
        }

        assert_eq!(result, Some(body.to_string()));
    }

    #[test]
    fn out_of_bounds_index_is_ignored_without_panicking() {
        let mut assembler = ChunkAssembler::new();
        let bad = chunk("group-4", 5, 2, "ignored");
        assert_eq!(assembler.feed(bad), None);
        // Rejected before the group exists, so it cannot hold a slot open for
        // the TTL either.
        assert!(assembler.groups.is_empty());
    }

    /// The H8 defect: `total` is attacker/corruption-controlled and was fed
    /// straight to `vec![None; total]`. `usize::MAX` panics on capacity
    /// overflow; a merely huge value aborts on allocation failure. Both kill
    /// `subscribe_loop`, and the dropped `JoinHandle` means it dies with no log
    /// line at all — every later question is silently lost.
    #[test]
    fn an_absurd_total_is_rejected_instead_of_allocated() {
        let mut assembler = ChunkAssembler::new();

        assert_eq!(assembler.feed(chunk("huge", 0, usize::MAX, "data")), None);
        assert_eq!(
            assembler.feed(chunk("huge-2", 0, MAX_CHUNKS + 1, "data")),
            None
        );

        assert!(assembler.groups.is_empty());
    }

    /// `vec![None; 0]` is empty, and `all()` over an empty iterator is `true` —
    /// so a zero-total fragment used to "complete" instantly and dispatch an
    /// empty string as a reassembled message body.
    #[test]
    fn a_zero_total_does_not_complete_vacuously() {
        let mut assembler = ChunkAssembler::new();
        assert_eq!(assembler.feed(chunk("empty", 0, 0, "")), None);
        assert!(assembler.groups.is_empty());
    }

    #[test]
    fn a_group_keeps_the_size_its_first_fragment_declared() {
        let mut assembler = ChunkAssembler::new();
        assert_eq!(assembler.feed(chunk("group-7", 0, 2, "AAAA")), None);

        // Same group, disagreeing total: dropped rather than written into a
        // wrongly-sized array.
        assert_eq!(assembler.feed(chunk("group-7", 0, 3, "ZZZZ")), None);

        let group = assembler.groups.get("group-7").expect("group is still open");
        assert_eq!(group.parts.len(), 2);
        assert_eq!(group.parts[0].as_deref(), Some("AAAA"));
    }

    /// Pins the *reason* for `MAX_CHUNKS`, not the number: the ceiling has to
    /// stay far above any body the server could legitimately split. Tightening
    /// it to something that truncates real messages should fail here rather
    /// than turn into questions that never arrive.
    #[test]
    fn the_chunk_ceiling_stays_far_above_any_real_message() {
        let assemblable_body_bytes = MAX_CHUNKS * SERVER_CHUNK_DATA_SIZE * 3 / 4;
        assert!(
            assemblable_body_bytes >= 1_000_000,
            "MAX_CHUNKS={} only assembles {} bytes of body; a 1 MB message would be dropped",
            MAX_CHUNKS,
            assemblable_body_bytes
        );
    }

    #[test]
    fn a_group_at_the_ceiling_still_assembles() {
        // 384 raw bytes encode to exactly MAX_CHUNKS base64 chars, so one char
        // per fragment lands the group precisely on the limit.
        let body = "x".repeat(MAX_CHUNKS * 3 / 4);
        let encoded = BASE64.encode(body.as_bytes());
        assert_eq!(encoded.len(), MAX_CHUNKS);

        let mut assembler = ChunkAssembler::new();
        let mut result = None;
        for (i, part) in encoded.as_bytes().chunks(1).enumerate() {
            let part = std::str::from_utf8(part).unwrap();
            result = assembler.feed(chunk("group-8", i, MAX_CHUNKS, part));
        }

        assert_eq!(result, Some(body));
    }

    #[test]
    fn stale_incomplete_group_is_evicted_after_ttl() {
        let mut assembler = ChunkAssembler::new();
        let first = chunk("group-5", 0, 2, "AAAA");
        assert_eq!(assembler.feed(first), None);

        std::thread::sleep(GROUP_TTL + Duration::from_millis(20));

        // Trigger eviction via an unrelated feed, then confirm the stale group
        // was dropped: completing "index 1" alone must not finish a group that
        // no longer remembers "index 0".
        let unrelated = chunk("group-6", 0, 1, &BASE64.encode(b"x"));
        assert!(assembler.feed(unrelated).is_some());

        let second = chunk("group-5", 1, 2, "BBBB");
        assert_eq!(assembler.feed(second), None);
    }
}
