use std::collections::{HashMap, VecDeque};

use crate::types::SenderInfo;

/// How many not-yet-open dialog/notification windows' sender identities to
/// remember at once. Sized for "one entry per pending window", not "every
/// message ever seen" — much smaller than `SEEN_ID_CAPACITY`.
const SENDER_IDENTITY_CACHE_CAPACITY: usize = 128;

/// Bounded FIFO cache of resolved sender identities, keyed by the
/// `forMessageId` of the question/notification they decorate.
///
/// Sibling of `SeenIds`: same `VecDeque` + bounded-eviction shape, but a value
/// store (`HashMap<String, SenderInfo>`) instead of a presence set, since a
/// `sender_identity` that arrives before its target window opens has to be
/// retrievable later, not just remembered as "seen".
pub struct SenderIdentityCache {
    order: VecDeque<String>,
    entries: HashMap<String, SenderInfo>,
    capacity: usize,
}

impl SenderIdentityCache {
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            order: VecDeque::with_capacity(capacity),
            entries: HashMap::with_capacity(capacity),
            capacity,
        }
    }

    /// FIFO-evicts the oldest entry when over capacity. Re-inserting an
    /// existing key updates its value without duplicating the eviction order,
    /// mirroring `SeenIds::insert`'s dedup-on-reinsert behavior.
    pub fn insert(&mut self, for_message_id: &str, sender: SenderInfo) {
        if self.entries.insert(for_message_id.to_string(), sender).is_none() {
            self.order.push_back(for_message_id.to_string());
            if self.order.len() > self.capacity {
                if let Some(evicted) = self.order.pop_front() {
                    self.entries.remove(&evicted);
                }
            }
        }
    }

    /// Absent for an unknown key — no panic, no error. This is the "unmatched
    /// identity is dropped silently" contract at the cache layer.
    pub fn get(&self, for_message_id: &str) -> Option<SenderInfo> {
        self.entries.get(for_message_id).cloned()
    }
}

impl Default for SenderIdentityCache {
    fn default() -> Self {
        Self::with_capacity(SENDER_IDENTITY_CACHE_CAPACITY)
    }
}

/// `SenderIdentityCache` behind a mutex, mirroring `OutstandingReviews` and
/// `AckWaiters`: a host's state container only ever hands back `&T`, so
/// interior mutability is not optional.
#[derive(Default)]
pub struct SenderIdentityCacheState(std::sync::Mutex<SenderIdentityCache>);

impl SenderIdentityCacheState {
    pub fn insert(&self, for_message_id: &str, sender: SenderInfo) {
        if let Ok(mut cache) = self.0.lock() {
            cache.insert(for_message_id, sender);
        }
    }

    pub fn get(&self, for_message_id: &str) -> Option<SenderInfo> {
        self.0.lock().ok().and_then(|cache| cache.get(for_message_id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Sibling of SeenIds: same VecDeque + bounded-eviction FIFO shape, but a
    // value store (HashMap<String, SenderInfo>) rather than a presence set,
    // since a sender_identity that arrives before its window opens has to be
    // retrievable later, not just remembered as "seen".

    fn a_sender(label: &str) -> SenderInfo {
        SenderInfo { label: label.to_string(), source: "worktree".to_string() }
    }

    #[test]
    fn sender_identity_cache_returns_what_was_inserted() {
        let mut cache = SenderIdentityCache::with_capacity(8);
        cache.insert("q-1", a_sender("Kay9 - work-item/1"));

        assert_eq!(cache.get("q-1").unwrap().label, "Kay9 - work-item/1");
    }

    #[test]
    fn sender_identity_cache_get_on_an_unknown_key_is_none_not_a_panic() {
        // This is the "unmatched identity is dropped" contract at the cache
        // layer: a miss must be an ordinary Option, never a panic or an error.
        let cache = SenderIdentityCache::with_capacity(8);
        assert!(cache.get("never-inserted").is_none());
    }

    #[test]
    fn sender_identity_cache_evicts_the_oldest_entry_once_over_capacity() {
        let mut cache = SenderIdentityCache::with_capacity(2);
        cache.insert("a", a_sender("A"));
        cache.insert("b", a_sender("B"));
        cache.insert("c", a_sender("C")); // evicts "a"

        assert!(cache.get("a").is_none(), "the oldest entry must have been evicted");
        assert_eq!(cache.get("b").unwrap().label, "B");
        assert_eq!(cache.get("c").unwrap().label, "C");
    }

    #[test]
    fn sender_identity_cache_reinsertion_does_not_grow_past_capacity() {
        let mut cache = SenderIdentityCache::with_capacity(4);
        for i in 0..10 {
            cache.insert("same", a_sender(&format!("v{i}")));
        }

        assert_eq!(cache.order.len(), 1);
        assert_eq!(cache.entries.len(), 1);
        assert_eq!(cache.get("same").unwrap().label, "v9", "the latest value wins");
    }
}
