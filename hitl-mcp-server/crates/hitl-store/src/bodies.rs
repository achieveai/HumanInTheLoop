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

    // --- What `capture_body` writes down when there is nothing to store ---
    //
    // Two binaries call this now, each through a wrapper of its own, and each
    // wrapper's tests assert what *it* returns. The row underneath is what a
    // reader actually renders from, and until these it was only ever checked
    // second-hand — through `body_status`, which decodes it, or through a
    // caller, which could stop looking without anything failing.
    //
    // `gone` is deliberately absent below: it is not a `capture_body` outcome.
    // Nothing this function can observe means "ntfy dropped the bytes" — that
    // verdict is reached before a fetch is spent (an expiry that has passed, or
    // no URL at all) or by a 404 afterwards, and both callers record it by
    // calling `record_body_failure` directly. `failures.rs` covers that path.

    use crate::BodyStatus;
    use hitl_transport::payload::encode_payload;
    use hitl_transport::types::PlanReviewBody;

    const KEY: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

    fn plan() -> PlanReviewBody {
        PlanReviewBody {
            content: "# Plan\n\nship it\n".to_string(),
            diff: "@@ -0,0 +1 @@\n+ship it\n".to_string(),
        }
    }

    /// `(reason, actual_hash, detail, ntfy_id)` — the four columns a reader
    /// renders from, in the order they are asserted below.
    type FailureRow = (String, Option<String>, Option<String>, Option<String>);

    /// The `body_failures` row as written, not as `body_status` decodes it.
    fn row(s: &Store, content_hash: &str) -> Option<FailureRow> {
        s.conn
            .query_row(
                "SELECT reason, actual_hash, detail, ntfy_id FROM body_failures WHERE content_hash = ?1",
                params![content_hash],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()
            .unwrap()
    }

    fn rows(s: &Store) -> i64 {
        s.conn
            .query_row("SELECT count(*) FROM body_failures", [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn a_hash_mismatch_writes_the_row_a_reader_needs_to_diagnose_it() {
        // `actual_hash` is the whole value of this row: it is where the bytes
        // were quarantined, and without it "corrupt" is an accusation with no
        // evidence attached and nowhere to go looking.
        let s = Store::open_in_memory().unwrap();
        let encoded = encode_payload(&plan(), None).unwrap();
        let claimed = "0".repeat(64);
        let actual = sha256_hex(&encoded.cipher);

        let outcome = s.capture_body(&claimed, &encoded.cipher, None, Some("ntfy-7"));

        assert_eq!(
            outcome,
            CaptureOutcome::HashMismatch {
                expected: claimed.clone(),
                actual: actual.clone(),
            }
        );
        let (reason, actual_hash, detail, ntfy_id) = row(&s, &claimed).expect("a row must be written");
        assert_eq!(reason, "corrupt", "the string `decode_status` matches on");
        assert_eq!(actual_hash.as_deref(), Some(actual.as_str()), "where the bytes went");
        assert_eq!(
            detail.as_deref(),
            Some(
                format!(
                    "claimed {claimed}, {} bytes hash to {actual}",
                    encoded.cipher.len()
                )
                .as_str()
            )
        );
        assert_eq!(ntfy_id.as_deref(), Some("ntfy-7"), "so an operator can find the event");
        // And the two halves of the quarantine, which the row is only half of.
        assert!(!s.has_body(&claimed).unwrap(), "nothing under the claimed hash");
        assert!(s.has_body(&actual).unwrap(), "the bytes survive for diagnosis");
    }

    #[test]
    fn a_body_this_machine_cannot_decrypt_writes_a_row_that_names_the_key() {
        // Not `corrupt`, and emphatically not `gone`: the bytes on the server
        // are fine and the operator is one config line from reading them.
        // `actual_hash` is `None` because nothing was ever hashed — there is no
        // plaintext to hash, which is precisely the complaint.
        let s = Store::open_in_memory().unwrap();
        let encoded = encode_payload(&plan(), Some(KEY)).unwrap();
        let hash = &encoded.payload_ref.content_hash;

        let outcome = s.capture_body(hash, &encoded.cipher, None, Some("ntfy-8"));

        assert!(matches!(outcome, CaptureOutcome::Undecryptable(_)), "{outcome:?}");
        let (reason, actual_hash, detail, ntfy_id) = row(&s, hash).expect("a row must be written");
        assert_eq!(reason, "undecryptable");
        assert_eq!(actual_hash, None, "nothing was hashed, so nothing was quarantined");
        assert_eq!(
            detail.as_deref(),
            Some("payload is encrypted but no encryptionKey is configured")
        );
        assert_eq!(ntfy_id.as_deref(), Some("ntfy-8"));
        assert!(!s.has_body(hash).unwrap(), "and nothing unverified is stored");
    }

    #[test]
    fn a_reference_with_no_hash_writes_no_row_at_all() {
        // The one refusal that must stay silent. An empty hash is not a body
        // that failed; it is a row keyed by nothing, which no reader could ever
        // look up and which would sit in the table forever bounding a retry of
        // something that was never identified in the first place.
        let s = Store::open_in_memory().unwrap();

        let outcome = s.capture_body("", "whatever bytes", None, Some("ntfy-9"));

        assert!(matches!(outcome, CaptureOutcome::Failed(_)), "{outcome:?}");
        assert_eq!(rows(&s), 0, "an unidentifiable body must not be written down");
        assert!(!s.body_failed("").unwrap());
    }

    #[test]
    fn a_body_that_verifies_retracts_the_explanation_left_by_an_earlier_attempt() {
        // A transient failure can look permanent once — a proxy that 404s
        // during a restart, say. The retry that succeeds must clear the row, or
        // the message reads "gone" forever with the good bytes sitting beside
        // it, and `body_failed` keeps blocking a fetch that has already worked.
        let s = Store::open_in_memory().unwrap();
        let encoded = encode_payload(&plan(), None).unwrap();
        let hash = &encoded.payload_ref.content_hash;
        s.record_body_failure(&BodyFailure {
            content_hash: hash,
            reason: FailureReason::Gone,
            actual_hash: None,
            detail: Some("404 during a proxy restart"),
            ntfy_id: Some("ntfy-1"),
        })
        .unwrap();

        assert_eq!(
            s.capture_body(hash, &encoded.cipher, None, Some("ntfy-1")),
            CaptureOutcome::Stored
        );

        assert_eq!(row(&s, hash), None, "the old explanation is now false");
        assert_eq!(s.body_status(hash).unwrap(), BodyStatus::Verified);
        assert!(!s.body_failed(hash).unwrap(), "and it is fetchable again");
    }
}
