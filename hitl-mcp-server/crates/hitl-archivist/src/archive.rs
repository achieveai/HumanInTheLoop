//! The durable side of the archivist: the event log, and the attachment bodies
//! that outlive ntfy.
//!
//! Wraps [`hitl_store::Store`] in a `Mutex` because `rusqlite::Connection` is
//! `Send` but not `Sync`, and [`hitl_transport::ntfy::NtfySink`] requires
//! `Sync`. The lock is never held across an `await`: every method here is
//! synchronous and returns before the caller can yield.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use hitl_store::{BodyFailure, BodyStatus, Event, FailureReason, Store};
use hitl_transport::crypto;
use hitl_transport::ntfy::subscribe::NtfyEvent;
use hitl_transport::payload::sha256_hex;

/// Ceiling on one backfill response, so a consumer that has been away for a
/// year does not ask for a single reply the size of the whole database.
pub const DEFAULT_BACKFILL_LIMIT: usize = 1000;

/// What happened to one attachment body.
///
/// Every variant is a fact the operator can act on; none of them is silence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BodyOutcome {
    /// Fetched, verified against `contentHash`, and persisted.
    Stored,
    /// Already held under that hash. The hash *is* the content, so there is
    /// nothing to re-fetch and nothing to compare.
    AlreadyHeld,
    /// The bytes did not hash to what the message said they would. Quarantined
    /// under the hash they actually have — see [`Archive::capture_body`].
    HashMismatch { expected: String, actual: String },
    /// Encrypted with a key this machine does not have, or the envelope did not
    /// decrypt. Nothing to verify, so nothing is stored.
    Undecryptable(String),
    /// The fetch or the write failed. The body may still be retrievable while
    /// the attachment lives.
    Failed(String),
}

/// The answer to "give me this body", which is never just bytes-or-nothing.
///
/// Three outcomes, because they mean three different things to a caller: here
/// it is; it is not here and this is why; and the archive could not tell you.
/// Collapsing the last two would report a broken database as a missing body.
#[derive(Debug)]
pub enum BodyLookup {
    Found(Vec<u8>),
    Missing(BodyStatus),
    Unavailable(String),
}

/// Running totals, for `GET /health`.
///
/// A headless recorder with no window has no other way to say whether it is
/// working, and "the process is up" is not the same claim as "events are
/// landing".
#[derive(Debug, Default)]
pub struct Stats {
    pub events_recorded: AtomicU64,
    pub bodies_stored: AtomicU64,
    pub body_failures: AtomicU64,
}

impl Stats {
    fn bump(counter: &AtomicU64) {
        counter.fetch_add(1, Ordering::Relaxed);
    }

    pub fn snapshot(&self) -> (u64, u64, u64) {
        (
            self.events_recorded.load(Ordering::Relaxed),
            self.bodies_stored.load(Ordering::Relaxed),
            self.body_failures.load(Ordering::Relaxed),
        )
    }
}

pub struct Archive {
    store: Mutex<Store>,
    pub stats: Stats,
}

impl Archive {
    pub fn open(path: impl AsRef<std::path::Path>) -> Result<Self, String> {
        Store::open(path)
            .map(Self::wrap)
            .map_err(|e| format!("could not open the archive: {e}"))
    }

    /// An archive with no file behind it. Test-only: the binary always has a
    /// path, and an archivist whose log evaporates on exit is the one thing
    /// this crate exists to prevent.
    #[cfg(test)]
    pub fn in_memory() -> Result<Self, String> {
        Store::open_in_memory()
            .map(Self::wrap)
            .map_err(|e| format!("could not open an in-memory archive: {e}"))
    }

    fn wrap(store: Store) -> Self {
        Self {
            store: Mutex::new(store),
            stats: Stats::default(),
        }
    }

    /// Record one event. Returns its local `seq`.
    ///
    /// Exactly-once is the store's `UNIQUE(ntfy_id)`, not anything kept here: a
    /// reconnect replays ntfy's cache window and the startup poll overlaps the
    /// live stream, so the same event arriving several times is the ordinary
    /// case. Deduping on ntfy's own id is the only scheme that also survives a
    /// restart, which an in-process seen-set does not.
    pub fn record(&self, event: &NtfyEvent, decrypted: &str) -> Result<i64, String> {
        let store = self.store.lock().map_err(|_| "archive lock poisoned".to_string())?;
        let seq = store
            .append(event, decrypted)
            .map_err(|e| format!("could not record event {}: {e}", event.id))?;
        Stats::bump(&self.stats.events_recorded);
        Ok(seq)
    }

    pub fn events_since(&self, seq: i64, limit: usize) -> Result<Vec<Event>, String> {
        let store = self.store.lock().map_err(|_| "archive lock poisoned".to_string())?;
        store
            .events_since(seq, limit)
            .map_err(|e| format!("could not read events after {seq}: {e}"))
    }

    pub fn count_events(&self) -> Result<i64, String> {
        let store = self.store.lock().map_err(|_| "archive lock poisoned".to_string())?;
        store.count_events().map_err(|e| e.to_string())
    }

    pub fn has_body(&self, content_hash: &str) -> bool {
        self.store
            .lock()
            .ok()
            .and_then(|s| s.has_body(content_hash).ok())
            .unwrap_or(false)
    }

    pub fn get_body(&self, content_hash: &str) -> Option<Vec<u8>> {
        self.store.lock().ok().and_then(|s| s.get_body(content_hash).ok().flatten())
    }

    #[cfg(test)]
    pub fn body_status(&self, content_hash: &str) -> BodyStatus {
        match self.look_up_body(content_hash) {
            BodyLookup::Found(_) => BodyStatus::Verified,
            BodyLookup::Missing(status) => status,
            BodyLookup::Unavailable(_) => BodyStatus::Unattempted,
        }
    }

    /// The body, or why there isn't one — decided under a single lock.
    ///
    /// One call rather than `get_body` then `body_status`, because between two
    /// calls a fetch can land: the pair can report "missing" and then explain
    /// that the body is `Verified`, which is not a state that ever existed.
    pub fn look_up_body(&self, content_hash: &str) -> BodyLookup {
        let Ok(store) = self.store.lock() else {
            return BodyLookup::Unavailable("archive lock poisoned".to_string());
        };

        match store.get_body(content_hash) {
            Ok(Some(bytes)) => BodyLookup::Found(bytes),
            Ok(None) => match store.body_status(content_hash) {
                Ok(status) => BodyLookup::Missing(status),
                Err(e) => BodyLookup::Unavailable(e.to_string()),
            },
            Err(e) => BodyLookup::Unavailable(e.to_string()),
        }
    }

    pub fn body_statuses(&self, content_hashes: &[&str]) -> Result<Vec<(String, BodyStatus)>, String> {
        let store = self.store.lock().map_err(|_| "archive lock poisoned".to_string())?;
        store
            .body_statuses(content_hashes)
            .map_err(|e| format!("could not read body statuses: {e}"))
    }

    /// Verify `cipher` against `expected_hash` and persist it.
    ///
    /// What gets stored is the **payload plaintext** — the `base64(gzip(json))`
    /// string — not the encrypted bytes that came off the wire. That string is
    /// the exact preimage of `contentHash` (see `payload.rs`), so anything
    /// reading this table later can re-verify the body against the hash it
    /// asked for, without holding the encryption key. Storing the ciphertext
    /// instead would key the table by a hash of something it does not contain.
    ///
    /// **On a mismatch the bytes are stored under the hash they actually have,
    /// never under the one the message claimed.** The two obvious alternatives
    /// are both worse. Storing them under `expected_hash` makes `get_body` a
    /// liar: every later reader trusts that key as verified, and spec §8.3
    /// requires a mismatch to render read-only with a warning — it cannot warn
    /// about something it can no longer detect. Dropping them makes the body
    /// indistinguishable from one that simply expired, which is the normal,
    /// blameless case, so a real corruption would read as routine. Quarantining
    /// gives both properties: a lookup by `expected_hash` correctly misses, and
    /// the bytes survive for whoever has to work out what went wrong.
    pub fn capture_body(
        &self,
        expected_hash: &str,
        cipher: &str,
        key: Option<&str>,
        ntfy_id: Option<&str>,
    ) -> BodyOutcome {
        if expected_hash.is_empty() {
            // Nothing to key a failure row by, and nothing a reader could ever
            // look up — the hash *is* the identity here.
            return self.fail(BodyOutcome::Failed(
                "payload reference carries no contentHash to verify against".to_string(),
            ));
        }
        if self.has_body(expected_hash) {
            return BodyOutcome::AlreadyHeld;
        }

        let plaintext = match plaintext_of(cipher, key) {
            Ok(p) => p,
            Err(e) => {
                self.note(&BodyFailure {
                    content_hash: expected_hash,
                    reason: FailureReason::Undecryptable,
                    actual_hash: None,
                    detail: Some(e.as_str()),
                    ntfy_id,
                });
                return self.fail(BodyOutcome::Undecryptable(e));
            }
        };

        let actual = sha256_hex(&plaintext);
        if actual != expected_hash {
            log::error!(
                "attachment body hash mismatch: message claimed {expected_hash}, bytes hash to \
                 {actual}. Quarantined under the hash the bytes actually have; nothing is stored \
                 under the claimed one."
            );
            let _ = self.put(&actual, plaintext.as_bytes());
            let detail = format!(
                "claimed {expected_hash}, {} bytes hash to {actual}",
                plaintext.len()
            );
            self.note(&BodyFailure {
                content_hash: expected_hash,
                reason: FailureReason::Corrupt,
                actual_hash: Some(actual.as_str()),
                detail: Some(detail.as_str()),
                ntfy_id,
            });
            return self.fail(BodyOutcome::HashMismatch {
                expected: expected_hash.to_string(),
                actual,
            });
        }

        match self.put(expected_hash, plaintext.as_bytes()) {
            Ok(()) => {
                Stats::bump(&self.stats.bodies_stored);
                // A body that turned up after a failure was recorded — a proxy
                // that 404d during a restart, say. The bytes are here and
                // verified, so the old explanation is now false.
                self.clear_failure(expected_hash);
                BodyOutcome::Stored
            }
            // Deliberately not recorded as a body failure: the fetch worked and
            // the bytes were right. The database is what is broken, and saying
            // "this body is unrecoverable" would be both wrong and unwritable.
            Err(e) => self.fail(BodyOutcome::Failed(e)),
        }
    }

    /// Record a body as gone before any fetch was spent on it.
    ///
    /// The two cases the sink can settle without touching the network: ntfy's
    /// own `expires` has passed, or it sent no URL at all. Both are permanent,
    /// and without a row here both would read as [`BodyStatus::Unattempted`] —
    /// a body still on its way, which it very much is not.
    ///
    /// [`BodyStatus::Unattempted`]: hitl_store::BodyStatus::Unattempted
    pub fn note_gone(&self, content_hash: &str, ntfy_id: &str, detail: &str) {
        self.note(&BodyFailure {
            content_hash,
            reason: FailureReason::Gone,
            actual_hash: None,
            detail: Some(detail),
            ntfy_id: Some(ntfy_id),
        });
    }

    /// Whether reaching for this body again could only fail the same way.
    ///
    /// Durable, and that is the point: the startup poll replays ntfy's whole
    /// cache on every boot, so an in-process set would re-fetch a body known to
    /// be corrupt once per restart for as long as its event stays cached.
    pub fn body_failed(&self, content_hash: &str) -> bool {
        self.store
            .lock()
            .ok()
            .and_then(|s| s.body_failed(content_hash).ok())
            .unwrap_or(false)
    }

    fn note(&self, failure: &BodyFailure<'_>) {
        let Ok(store) = self.store.lock() else {
            log::error!("archive lock poisoned; cannot record why a body is missing");
            return;
        };
        if let Err(e) = store.record_body_failure(failure) {
            // Not fatal. The body is lost either way; this only costs a reader
            // the explanation, and stopping ingest over it would cost far more.
            log::error!("could not record body failure for {}: {e}", failure.content_hash);
        }
    }

    fn clear_failure(&self, content_hash: &str) {
        if let Ok(store) = self.store.lock() {
            let _ = store.clear_body_failure(content_hash);
        }
    }

    /// Seed bytes under a hash without verifying them.
    ///
    /// Test-only, and it must stay that way: skipping verification is precisely
    /// what [`Archive::capture_body`] exists to prevent. Tests of the *serving*
    /// path need bytes that are deliberately not a valid payload, which no
    /// honest path can produce.
    #[cfg(test)]
    pub fn put_body_for_test(&self, content_hash: &str, bytes: &[u8]) {
        self.put(content_hash, bytes).expect("test seed must store");
    }

    fn put(&self, content_hash: &str, bytes: &[u8]) -> Result<(), String> {
        let store = self.store.lock().map_err(|_| "archive lock poisoned".to_string())?;
        store
            .put_body(content_hash, bytes)
            .map_err(|e| format!("could not store body {content_hash}: {e}"))
    }

    /// Count an outcome as a failure and hand it back unchanged.
    fn fail(&self, outcome: BodyOutcome) -> BodyOutcome {
        Stats::bump(&self.stats.body_failures);
        outcome
    }
}

/// The payload plaintext behind a wire `cipher`.
///
/// Decides by inspecting the envelope rather than by whether a key is
/// configured. A topic can carry unencrypted payloads on a machine that has a
/// key (an older publisher, or one with encryption off), and assuming
/// otherwise would turn a perfectly readable body into a decrypt failure.
fn plaintext_of(cipher: &str, key: Option<&str>) -> Result<String, String> {
    let cipher = cipher.trim();

    match serde_json::from_str::<serde_json::Value>(cipher) {
        Ok(value) if crypto::is_encrypted(&value) => {
            let key = key.ok_or_else(|| {
                "payload is encrypted but no encryptionKey is configured".to_string()
            })?;
            crypto::decrypt_value(&value, key)
        }
        // Not an envelope: with no key in play the cipher *is* the plaintext.
        _ => Ok(cipher.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use hitl_transport::payload::encode_payload;
    use hitl_transport::types::PlanReviewBody;

    const KEY: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

    fn body() -> PlanReviewBody {
        PlanReviewBody {
            content: "# Plan\n\nship it\n".to_string(),
            diff: "@@ -0,0 +1 @@\n+ship it\n".to_string(),
        }
    }

    #[test]
    fn a_verified_body_is_stored_under_the_hash_the_message_claimed() {
        let archive = Archive::in_memory().unwrap();
        let encoded = encode_payload(&body(), Some(KEY)).unwrap();
        let hash = &encoded.payload_ref.content_hash;

        assert_eq!(
            archive.capture_body(hash, &encoded.cipher, Some(KEY), Some("ntfy-t")),
            BodyOutcome::Stored
        );
        assert!(archive.has_body(hash));
        assert_eq!(archive.stats.snapshot(), (0, 1, 0));
    }

    #[test]
    fn what_is_stored_is_the_preimage_of_the_hash_it_is_keyed_by() {
        // The property a later reader depends on: it can re-verify the body it
        // was handed without holding the encryption key. Storing the wire
        // ciphertext would key the table by a hash of something else entirely.
        let archive = Archive::in_memory().unwrap();
        let encoded = encode_payload(&body(), Some(KEY)).unwrap();
        let hash = &encoded.payload_ref.content_hash;

        archive.capture_body(hash, &encoded.cipher, Some(KEY), Some("ntfy-t"));
        let stored = archive.get_body(hash).expect("body must be held");

        assert_eq!(sha256_hex(&String::from_utf8(stored).unwrap()), *hash);
    }

    #[test]
    fn an_unencrypted_payload_verifies_the_same_way() {
        let archive = Archive::in_memory().unwrap();
        let encoded = encode_payload(&body(), None).unwrap();

        assert_eq!(
            archive.capture_body(&encoded.payload_ref.content_hash, &encoded.cipher, None, Some("ntfy-t")),
            BodyOutcome::Stored
        );
    }

    #[test]
    fn an_unencrypted_payload_is_still_read_on_a_machine_that_has_a_key() {
        // A publisher with encryption off, or one predating it. Deciding by
        // envelope rather than by "is a key configured" is what keeps this
        // readable instead of reporting a decrypt failure.
        let archive = Archive::in_memory().unwrap();
        let encoded = encode_payload(&body(), None).unwrap();

        assert_eq!(
            archive.capture_body(&encoded.payload_ref.content_hash, &encoded.cipher, Some(KEY), Some("ntfy-t")),
            BodyOutcome::Stored
        );
    }

    #[test]
    fn a_mismatched_body_is_never_stored_under_the_hash_it_claimed() {
        // The whole point. If this ever stores under `claimed`, every later
        // reader treats corrupt bytes as verified content, and spec 8.3's
        // read-only warning can never fire because nothing can detect it.
        let archive = Archive::in_memory().unwrap();
        let encoded = encode_payload(&body(), None).unwrap();
        let claimed = "0".repeat(64);

        let outcome = archive.capture_body(&claimed, &encoded.cipher, None, Some("ntfy-t"));

        assert!(matches!(outcome, BodyOutcome::HashMismatch { .. }), "{outcome:?}");
        assert!(!archive.has_body(&claimed), "the claimed hash must miss");
    }

    #[test]
    fn a_mismatched_body_is_quarantined_rather_than_thrown_away() {
        // Dropping it would make corruption indistinguishable from the normal,
        // blameless case of an attachment that simply expired.
        let archive = Archive::in_memory().unwrap();
        let encoded = encode_payload(&body(), None).unwrap();
        let actual_hash = sha256_hex(&encoded.cipher);

        let outcome = archive.capture_body(&"0".repeat(64), &encoded.cipher, None, Some("ntfy-t"));

        assert_eq!(
            outcome,
            BodyOutcome::HashMismatch {
                expected: "0".repeat(64),
                actual: actual_hash.clone(),
            }
        );
        assert!(archive.has_body(&actual_hash), "the bytes must survive for diagnosis");
        assert_eq!(archive.stats.snapshot().2, 1, "and it must count as a failure");
    }

    #[test]
    fn a_body_that_cannot_be_decrypted_is_a_failure_not_a_stored_body() {
        let archive = Archive::in_memory().unwrap();
        let encoded = encode_payload(&body(), Some(KEY)).unwrap();

        let outcome =
            archive.capture_body(&encoded.payload_ref.content_hash, &encoded.cipher, None, Some("ntfy-t"));

        assert!(matches!(outcome, BodyOutcome::Undecryptable(_)), "{outcome:?}");
        assert!(!archive.has_body(&encoded.payload_ref.content_hash));
        assert_eq!(archive.stats.snapshot().2, 1);
    }

    #[test]
    fn a_reference_with_no_hash_is_refused_rather_than_stored_unverified() {
        let archive = Archive::in_memory().unwrap();

        let outcome = archive.capture_body("", "whatever", None, Some("ntfy-t"));

        assert!(matches!(outcome, BodyOutcome::Failed(_)), "{outcome:?}");
        assert_eq!(archive.stats.snapshot().2, 1);
    }

    #[test]
    fn a_body_already_held_is_not_re_stored() {
        let archive = Archive::in_memory().unwrap();
        let encoded = encode_payload(&body(), None).unwrap();
        let hash = &encoded.payload_ref.content_hash;

        archive.capture_body(hash, &encoded.cipher, None, Some("ntfy-t"));
        assert_eq!(
            archive.capture_body(hash, &encoded.cipher, None, Some("ntfy-t")),
            BodyOutcome::AlreadyHeld
        );
        assert_eq!(archive.stats.snapshot().1, 1, "stored once, not twice");
    }
}
