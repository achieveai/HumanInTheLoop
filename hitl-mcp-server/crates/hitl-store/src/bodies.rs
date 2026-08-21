//! Attachment bytes, keyed by content hash.
//!
//! The one table besides `events` that is durable truth rather than a
//! projection. ntfy expires attachments after 3 h but keeps messages for 12 h,
//! so a plan body that was not captured at ingest is gone forever and no amount
//! of replaying the log will bring it back (spec §8.3, §10).

use rusqlite::{params, OptionalExtension};

use crate::{Result, Store};

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
