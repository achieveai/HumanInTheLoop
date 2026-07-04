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
    pub fn feed(&mut self, chunk: ChunkMessage) -> Option<String> {
        self.evict_stale();

        let group = self
            .groups
            .entry(chunk.group_id.clone())
            .or_insert_with(|| PendingGroup {
                parts: vec![None; chunk.total],
                first_seen: Instant::now(),
            });

        if chunk.index < group.parts.len() {
            group.parts[chunk.index] = Some(chunk.data);
        }

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
