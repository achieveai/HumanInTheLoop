//! Why a referenced body is not in `bodies`.
//!
//! `get_body` returning `None` is four different facts wearing one coat:
//!
//! | Fate | What a reader should do |
//! |---|---|
//! | held and verified | render it |
//! | fetched, hash mismatched | warn — the bytes exist but are not the plan |
//! | gone from ntfy | say so; it is never coming |
//! | never attempted | wait, it may still land |
//!
//! Only the first is visible from `bodies` alone, and the middle two are
//! precisely the ones worth telling apart: "this plan is corrupt" and "this
//! plan is still on its way" call for opposite reactions from a human.
//!
//! # This table is durable, not a projection
//!
//! [`crate::schema`]'s invariant is that anything outside `events` can be
//! dropped and rebuilt from the log. `body_failures` is an exception for the
//! same reason `bodies` is: replaying `events` re-derives what a message
//! *referenced*, never what happened when we reached for it. A 404 is not in
//! the log and never will be.
//!
//! # The clock here is diagnostic, and only diagnostic
//!
//! `at` is wall-clock seconds, the one such field in this crate. Everything
//! that decides *what is true* — [`crate::fold`] above all — orders by ntfy's
//! `(time, id)` and never consults a local clock, because two devices folding
//! the same events must reach the same answer with no arbiter between them.
//!
//! `at` buys none of that and must never be folded on. It answers "when did
//! this machine last try", for a human reading a log. Two machines will
//! disagree about it and both will be right.

use rusqlite::{params, OptionalExtension};

use crate::{Result, Store};

/// Why a fetch ended without a usable body. Only outcomes a retry cannot fix
/// belong here — a transient network error is *not* a failure, it is a body
/// still on its way, and recording it would turn "try again later" into
/// "abandoned".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureReason {
    /// Fetched, but the bytes did not hash to what the message claimed.
    Corrupt,
    /// The attachment left ntfy before it was captured, or never had a URL to
    /// fetch. Nothing brings it back.
    Gone,
    /// Fetched, but this machine could not read it: no key, or a bad envelope.
    Undecryptable,
}

impl FailureReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Corrupt => "corrupt",
            Self::Gone => "gone",
            Self::Undecryptable => "undecryptable",
        }
    }
}

/// One unresolved failure, as written.
#[derive(Debug, Clone)]
pub struct BodyFailure<'a> {
    /// The hash the message **claimed** — the name every consumer looks a body
    /// up by, which on a mismatch is deliberately not the hash the bytes have.
    pub content_hash: &'a str,
    pub reason: FailureReason,
    /// Where corrupt bytes were quarantined. `None` for every other reason.
    pub actual_hash: Option<&'a str>,
    /// For a human reading a log. Never branch on it — the strings are not a
    /// contract and will change.
    pub detail: Option<&'a str>,
    /// The event that referenced the body, so an operator can find it.
    pub ntfy_id: Option<&'a str>,
}

/// The state of one body, as a reader should render it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BodyStatus {
    /// Held, under the hash the message claimed. Since that hash was verified
    /// against the bytes before they were stored, holding it *is* the proof.
    Verified,
    /// The bytes on the server are not the ones the message describes.
    /// `actual_hash` is where they were quarantined, for diagnosis.
    Corrupt {
        actual_hash: Option<String>,
        detail: Option<String>,
        at: i64,
    },
    /// Unrecoverable. ntfy dropped the attachment, or never gave a URL.
    Gone { detail: Option<String>, at: i64 },
    /// Reachable but unreadable here — almost always a missing `encryptionKey`.
    Undecryptable { detail: Option<String>, at: i64 },
    /// A failure written by a newer build than this one.
    ///
    /// Reported rather than guessed at, on the same principle that keeps
    /// `verdict` a `String` on the wire: a value from a newer peer must not be
    /// forced into one of today's cases. Mapping it to [`Self::Gone`] would
    /// declare a recoverable body dead; mapping it to [`Self::Unattempted`]
    /// would promise one that is never coming.
    Unknown {
        reason: String,
        detail: Option<String>,
        at: i64,
    },
    /// Nothing has failed and nothing is held: either untried, or still in
    /// flight. Not a problem in itself — every body looks like this briefly.
    Unattempted,
}

impl Store {
    /// Record a body as unrecoverable. Last write wins: a hash that fails twice
    /// is one body with one current explanation, not a history.
    pub fn record_body_failure(&self, failure: &BodyFailure<'_>) -> Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO body_failures
               (content_hash, reason, actual_hash, detail, ntfy_id, at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                failure.content_hash,
                failure.reason.as_str(),
                failure.actual_hash,
                failure.detail,
                failure.ntfy_id,
                now_secs(),
            ],
        )?;
        Ok(())
    }

    /// Forget a failure, because the body arrived after all.
    ///
    /// A transient error can look permanent once — a proxy that 404s during a
    /// restart, say — and the retry that succeeds must not leave the message
    /// reading "corrupt" forever with the good bytes sitting next to it.
    pub fn clear_body_failure(&self, content_hash: &str) -> Result<()> {
        self.conn.execute(
            "DELETE FROM body_failures WHERE content_hash = ?1",
            params![content_hash],
        )?;
        Ok(())
    }

    /// What became of the body a message referenced.
    ///
    /// `bodies` is consulted first and wins outright: holding the bytes under
    /// the claimed hash means they were verified against it, and that fact
    /// outranks any older record of a failed attempt.
    pub fn body_status(&self, content_hash: &str) -> Result<BodyStatus> {
        if self.has_body(content_hash)? {
            return Ok(BodyStatus::Verified);
        }

        let row = self
            .conn
            .query_row(
                "SELECT reason, actual_hash, detail, at FROM body_failures WHERE content_hash = ?1",
                params![content_hash],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, Option<String>>(1)?,
                        r.get::<_, Option<String>>(2)?,
                        r.get::<_, i64>(3)?,
                    ))
                },
            )
            .optional()?;

        let Some((reason, actual_hash, detail, at)) = row else {
            return Ok(BodyStatus::Unattempted);
        };

        Ok(match reason.as_str() {
            "corrupt" => BodyStatus::Corrupt {
                actual_hash,
                detail,
                at,
            },
            "gone" => BodyStatus::Gone { detail, at },
            "undecryptable" => BodyStatus::Undecryptable { detail, at },
            _ => BodyStatus::Unknown { reason, detail, at },
        })
    }

    /// Whether reaching for this body again could only fail the same way.
    ///
    /// The fetcher's bound. Durable on purpose: the startup poll replays ntfy's
    /// whole cache on every boot, so an in-process set would re-attempt a body
    /// known to be corrupt once per restart, for as long as its event stays
    /// cached — and that window is being deliberately lengthened.
    pub fn body_failed(&self, content_hash: &str) -> Result<bool> {
        let found: i64 = self.conn.query_row(
            "SELECT count(*) FROM body_failures WHERE content_hash = ?1",
            params![content_hash],
            |row| row.get(0),
        )?;
        Ok(found > 0)
    }
}

/// See the module comment: diagnostic only, never an ordering key.
fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn failure(hash: &str, reason: FailureReason) -> BodyFailure<'_> {
        BodyFailure {
            content_hash: hash,
            reason,
            actual_hash: None,
            detail: None,
            ntfy_id: None,
        }
    }

    #[test]
    fn a_body_nobody_has_touched_is_unattempted_rather_than_failed() {
        // The distinction the whole table exists for. Before it, this and a
        // permanently corrupt body were the same answer.
        let s = Store::open_in_memory().unwrap();
        assert_eq!(s.body_status("sha-missing").unwrap(), BodyStatus::Unattempted);
        assert!(!s.body_failed("sha-missing").unwrap());
    }

    #[test]
    fn a_held_body_is_verified() {
        let s = Store::open_in_memory().unwrap();
        s.put_body("sha-1", b"plan").unwrap();
        assert_eq!(s.body_status("sha-1").unwrap(), BodyStatus::Verified);
    }

    #[test]
    fn corruption_is_distinguishable_from_expiry_and_from_a_missing_key() {
        // Four fates, four answers. Collapsing any two of these back together
        // is the regression this table was added to prevent.
        let s = Store::open_in_memory().unwrap();
        s.put_body("sha-ok", b"plan").unwrap();
        s.record_body_failure(&BodyFailure {
            content_hash: "sha-bad",
            reason: FailureReason::Corrupt,
            actual_hash: Some("sha-actual"),
            detail: Some("claimed sha-bad, hashes to sha-actual"),
            ntfy_id: Some("ntfy-7"),
        })
        .unwrap();
        s.record_body_failure(&failure("sha-gone", FailureReason::Gone)).unwrap();
        s.record_body_failure(&failure("sha-locked", FailureReason::Undecryptable))
            .unwrap();

        assert_eq!(s.body_status("sha-ok").unwrap(), BodyStatus::Verified);
        assert_eq!(s.body_status("sha-none").unwrap(), BodyStatus::Unattempted);
        assert!(matches!(s.body_status("sha-gone").unwrap(), BodyStatus::Gone { .. }));
        assert!(matches!(
            s.body_status("sha-locked").unwrap(),
            BodyStatus::Undecryptable { .. }
        ));

        let BodyStatus::Corrupt { actual_hash, detail, at } = s.body_status("sha-bad").unwrap()
        else {
            panic!("a mismatched body must read as corrupt");
        };
        assert_eq!(actual_hash.as_deref(), Some("sha-actual"), "diagnosis needs the bytes");
        assert!(detail.is_some());
        assert!(at > 0, "and when it happened");
    }

    #[test]
    fn a_corrupt_body_is_never_reported_as_verified() {
        // The claimed hash must miss in `bodies` — the quarantine keeps the
        // bytes under their *actual* hash — so this must not read as held.
        let s = Store::open_in_memory().unwrap();
        s.put_body("sha-actual", b"corrupt bytes").unwrap();
        s.record_body_failure(&BodyFailure {
            content_hash: "sha-claimed",
            reason: FailureReason::Corrupt,
            actual_hash: Some("sha-actual"),
            detail: None,
            ntfy_id: None,
        })
        .unwrap();

        assert!(matches!(
            s.body_status("sha-claimed").unwrap(),
            BodyStatus::Corrupt { .. }
        ));
    }

    #[test]
    fn a_body_that_arrives_after_a_failure_reads_as_verified() {
        // `bodies` wins over an older failure row. Holding the bytes under the
        // claimed hash means they were verified against it.
        let s = Store::open_in_memory().unwrap();
        s.record_body_failure(&failure("sha-1", FailureReason::Gone)).unwrap();

        s.put_body("sha-1", b"it turned up").unwrap();
        s.clear_body_failure("sha-1").unwrap();

        assert_eq!(s.body_status("sha-1").unwrap(), BodyStatus::Verified);
        assert!(!s.body_failed("sha-1").unwrap(), "and it is fetchable again");
    }

    #[test]
    fn the_latest_explanation_replaces_the_last_one() {
        let s = Store::open_in_memory().unwrap();
        s.record_body_failure(&failure("sha-1", FailureReason::Undecryptable)).unwrap();
        s.record_body_failure(&failure("sha-1", FailureReason::Gone)).unwrap();

        assert!(matches!(s.body_status("sha-1").unwrap(), BodyStatus::Gone { .. }));
        let rows: i64 = s
            .conn
            .query_row("SELECT count(*) FROM body_failures", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1, "one body, one current explanation");
    }

    #[test]
    fn a_reason_from_a_newer_build_is_reported_rather_than_guessed_at() {
        // Forcing it into `Gone` would declare a recoverable body dead;
        // forcing it into `Unattempted` would promise one that is not coming.
        let s = Store::open_in_memory().unwrap();
        s.conn
            .execute(
                "INSERT INTO body_failures (content_hash, reason, detail, at)
                 VALUES ('sha-1', 'quarantined_by_policy', 'from v3', 99)",
                [],
            )
            .unwrap();

        assert_eq!(
            s.body_status("sha-1").unwrap(),
            BodyStatus::Unknown {
                reason: "quarantined_by_policy".to_string(),
                detail: Some("from v3".to_string()),
                at: 99,
            }
        );
        assert!(s.body_failed("sha-1").unwrap(), "and it still bounds the retry");
    }

    #[test]
    fn a_recorded_failure_stops_the_fetcher_retrying_it() {
        let s = Store::open_in_memory().unwrap();
        assert!(!s.body_failed("sha-1").unwrap());

        s.record_body_failure(&failure("sha-1", FailureReason::Corrupt)).unwrap();

        assert!(s.body_failed("sha-1").unwrap());
        assert!(!s.body_failed("sha-2").unwrap(), "and blocks nothing else");
    }

    #[test]
    fn a_failure_outlives_the_process_that_recorded_it() {
        // The whole reason this moved out of an in-process set. The daemon is
        // closed at every logout and reboot, and the startup poll replays
        // ntfy's entire cache — so a bound that forgets on restart re-fetches a
        // body known to be corrupt once per boot, for as long as its event
        // stays cached. An in-memory store cannot show this; only a reopen can.
        let path = std::env::temp_dir().join(format!(
            "hitl-store-failure-durability-{}.db",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));

        {
            let s = Store::open(&path).unwrap();
            s.record_body_failure(&BodyFailure {
                content_hash: "sha-corrupt",
                reason: FailureReason::Corrupt,
                actual_hash: Some("sha-actual"),
                detail: None,
                ntfy_id: Some("ntfy-1"),
            })
            .unwrap();
        } // dropped: the process is gone.

        let reopened = Store::open(&path).unwrap();
        assert!(reopened.body_failed("sha-corrupt").unwrap(), "the bound must survive a reboot");
        assert!(matches!(
            reopened.body_status("sha-corrupt").unwrap(),
            BodyStatus::Corrupt { .. }
        ));

        drop(reopened);
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }

    #[test]
    fn the_reason_written_is_the_string_the_schema_documents() {
        // The column is TEXT and readers match on these exact values; renaming
        // one silently turns every existing row into `Unknown`.
        assert_eq!(FailureReason::Corrupt.as_str(), "corrupt");
        assert_eq!(FailureReason::Gone.as_str(), "gone");
        assert_eq!(FailureReason::Undecryptable.as_str(), "undecryptable");
    }
}
