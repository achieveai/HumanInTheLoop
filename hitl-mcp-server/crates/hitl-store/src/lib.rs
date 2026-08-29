//! The local event log every HITL client derives its view of the world from.
//!
//! One rule governs the whole design:
//!
//! ```text
//! status(messageId) = fold(all events whose subject is messageId, in ntfy order)
//! ```
//!
//! Status is never stored as authoritative state. It is derived, every time,
//! from the events that were actually observed. [`fold`] is a pure function
//! over a slice — no I/O, no clock, no network, no randomness — which is what
//! lets two devices independently compute the same winner of a reply race with
//! no arbiter and no coordination between them (spec §4.2, §9.2).
//!
//! The database is a cache of that computation, never its source. See
//! [`schema`] for the invariant that keeps it honest.

pub mod bodies;
pub mod events;
pub mod failures;
pub mod fold;
pub mod project;
pub mod schema;

use std::path::Path;

use rusqlite::Connection;

pub use bodies::CaptureOutcome;
pub use events::Event;
pub use failures::{BodyFailure, BodyStatus, FailureReason};
pub use fold::{fold, MessageState, Status, Verdict};

pub type Result<T> = rusqlite::Result<T>;

/// A SQLite-backed event log plus its projections.
pub struct Store {
    conn: Connection,
}

impl Store {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let conn = Connection::open(path)?;
        Self::init(conn)
    }

    /// An ephemeral store. Used by tests, and by any consumer that wants the
    /// projection without the file.
    pub fn open_in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Self> {
        // The log is append-only and read constantly by the UI; WAL is what
        // keeps a write from blocking the read that is drawing the list.
        // Ignored rather than propagated: an in-memory database refuses WAL,
        // and that is not a failure to open a store.
        let _ = conn.pragma_update(None, "journal_mode", "WAL");
        // SQLite defaults to `FULL`, which fsyncs on every commit. That default
        // exists for rollback-journal mode, where it is the only thing standing
        // between a power cut and a corrupt file. In WAL mode `NORMAL` cannot
        // corrupt the database at all — the worst a crash costs is the last few
        // committed transactions, which for an append-only log of ntfy events is
        // a handful of messages the next cache poll replays anyway.
        //
        // Measured on the startup replay: fsync-per-append was the single
        // largest cost in the cold path, ahead of decryption and dispatch
        // combined.
        let _ = conn.pragma_update(None, "synchronous", "NORMAL");
        schema::migrate(&conn)?;
        Ok(Self { conn })
    }
}
