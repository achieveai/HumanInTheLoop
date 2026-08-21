//! Attachment bytes, keyed by content hash.
//!
//! The one table besides `events` that is durable truth rather than a
//! projection. ntfy expires attachments after 3 h but keeps messages for 12 h,
//! so a plan body that was not captured at ingest is gone forever and no amount
//! of replaying the log will bring it back (spec §8.3, §10).
//!
//! # Why the verification lives here and not in the callers
//!
//! Two processes capture bodies at ingest — the archivist and the Inbox — and
//! both must reach the identical verdict about the same bytes. [`Store::capture_body`]
//! is that single verdict: hash-verify, quarantine on a mismatch, and record
//! *why* when there is nothing to store. A second copy of this policy that
//! drifted would let one app render a plan the other refuses, which is exactly
//! the failure spec §8.3's hash check exists to make impossible.

use hitl_transport::crypto;
use hitl_transport::payload::sha256_hex;
use rusqlite::{params, OptionalExtension};

use crate::{BodyFailure, FailureReason, Result, Store};

/// What capturing one body produced.
///
/// Every variant is a fact the operator can act on; none of them is silence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CaptureOutcome {
    /// Verified against `contentHash` and persisted.
    Stored,
    /// Already held under that hash. The hash *is* the content, so there is
    /// nothing to re-fetch and nothing to compare.
    AlreadyHeld,
    /// The bytes did not hash to what the message said they would. Quarantined
    /// under the hash they actually have — see [`Store::capture_body`].
    HashMismatch { expected: String, actual: String },
    /// Encrypted with a key this machine does not have, or the envelope did not
    /// decrypt. Nothing to verify, so nothing is stored.
    Undecryptable(String),
    /// The write failed. The body may still be retrievable while the
    /// attachment lives.
    Failed(String),
}

impl Store {
    /// Store `bytes` under `content_hash`. Idempotent: the hash *is* the
    /// content, so a second write of the same body is not a conflict.
    pub fn put_body(&self, content_hash: &str, bytes: &[u8]) -> Result<()> {
        self.conn.execute(
            "INSERT OR IGNORE INTO bodies (content_hash, bytes) VALUES (?1, ?2)",
            params![content_hash, bytes],
        )?;
        Ok(())
    }

    pub fn get_body(&self, content_hash: &str) -> Result<Option<Vec<u8>>> {
        self.conn
            .query_row(
                "SELECT bytes FROM bodies WHERE content_hash = ?1",
                params![content_hash],
                |row| row.get::<_, Vec<u8>>(0),
            )
            .optional()
    }

    /// Whether the body is already local — the question the archivist asks
    /// before spending a fetch on an attachment that may already have expired.
    pub fn has_body(&self, content_hash: &str) -> Result<bool> {
        let found: i64 = self.conn.query_row(
            "SELECT count(*) FROM bodies WHERE content_hash = ?1",
            params![content_hash],
            |row| row.get(0),
        )?;
        Ok(found > 0)
    }

    /// Verify `cipher` against `expected_hash` and persist it.
    ///
    /// What gets stored is the **payload plaintext** — the `base64(gzip(json))`
    /// string — not the encrypted bytes that came off the wire. That string is
    /// the exact preimage of `contentHash` (see `hitl_transport::payload`), so
    /// anything reading this table later can re-verify the body against the hash
    /// it asked for, without holding the encryption key. Storing the ciphertext
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
    ///
    /// Failures are written to `body_failures` rather than swallowed, so a
    /// reader is told *why* there is nothing rather than left waiting.
    pub fn capture_body(
        &self,
        expected_hash: &str,
        cipher: &str,
        key: Option<&str>,
        ntfy_id: Option<&str>,
    ) -> CaptureOutcome {
        if expected_hash.is_empty() {
            // Nothing to key a failure row by, and nothing a reader could ever
            // look up — the hash *is* the identity here.
            return CaptureOutcome::Failed(
                "payload reference carries no contentHash to verify against".to_string(),
            );
        }
        match self.has_body(expected_hash) {
            Ok(true) => return CaptureOutcome::AlreadyHeld,
            Ok(false) => {}
            Err(e) => return CaptureOutcome::Failed(e.to_string()),
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
                return CaptureOutcome::Undecryptable(e);
            }
        };

        let actual = sha256_hex(&plaintext);
        if actual != expected_hash {
            let _ = self.put_body(&actual, plaintext.as_bytes());
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
            return CaptureOutcome::HashMismatch {
                expected: expected_hash.to_string(),
                actual,
            };
        }

        match self.put_body(expected_hash, plaintext.as_bytes()) {
            Ok(()) => {
                // A body that turned up after a failure was recorded — a proxy
                // that 404d during a restart, say. The bytes are here and
                // verified, so the old explanation is now false.
                let _ = self.clear_body_failure(expected_hash);
                CaptureOutcome::Stored
            }
            // Deliberately not recorded as a body failure: the bytes were right
            // and it was the database that broke. Saying "this body is
            // unrecoverable" would be both wrong and, on a broken database,
            // unwritable.
            Err(e) => CaptureOutcome::Failed(e.to_string()),
        }
    }

    /// Record why a body will never be readable. Best effort by design: the body
    /// is lost either way, and failing the caller over a lost explanation would
    /// cost far more than it saves.
    fn note(&self, failure: &BodyFailure<'_>) {
        let _ = self.record_body_failure(failure);
    }
}

/// The payload plaintext behind a wire `cipher`.
///
/// Decides by inspecting the envelope rather than by whether a key is
/// configured. A topic can carry unencrypted payloads on a machine that has a
/// key (an older publisher, or one with encryption off), and assuming
/// otherwise would turn a perfectly readable body into a decrypt failure.
fn plaintext_of(cipher: &str, key: Option<&str>) -> std::result::Result<String, String> {
    let cipher = cipher.trim();

    match serde_json::from_str::<serde_json::Value>(cipher) {
        Ok(value) if crypto::is_encrypted(&value) => {
            let key = key
                .ok_or_else(|| "payload is encrypted but no encryptionKey is configured".to_string())?;
            crypto::decrypt_value(&value, key)
        }
        // Not an envelope: with no key in play the cipher *is* the plaintext.
        _ => Ok(cipher.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_body_round_trips_by_its_hash() {
        let s = Store::open_in_memory().unwrap();
        s.put_body("sha256:aaaa", b"plan bytes").unwrap();

        assert_eq!(s.get_body("sha256:aaaa").unwrap().as_deref(), Some(&b"plan bytes"[..]));
        assert!(s.has_body("sha256:aaaa").unwrap());
    }

    #[test]
    fn an_absent_body_is_none_rather_than_an_error() {
        // The expected case past ntfy's 3 h attachment window, not a fault.
        let s = Store::open_in_memory().unwrap();
        assert_eq!(s.get_body("sha256:missing").unwrap(), None);
        assert!(!s.has_body("sha256:missing").unwrap());
    }

    #[test]
    fn storing_the_same_body_twice_keeps_the_first_bytes() {
        let s = Store::open_in_memory().unwrap();
        s.put_body("sha256:aaaa", b"original").unwrap();
        s.put_body("sha256:aaaa", b"different").unwrap();

        assert_eq!(s.get_body("sha256:aaaa").unwrap().as_deref(), Some(&b"original"[..]));
    }
}
