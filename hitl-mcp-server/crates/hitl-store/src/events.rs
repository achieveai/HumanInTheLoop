//! Ingest: one ntfy event in, one immutable log row out.
//!
//! Nothing in here interprets an event. It records what arrived and what it was
//! about; deciding what that *means* is [`crate::fold`]'s job and happens on
//! read, never on write.

use rusqlite::{params, OptionalExtension};
use serde_json::Value;

use hitl_transport::ntfy::subscribe::NtfyEvent;

use crate::{Result, Store};

/// One row of the append-only log.
///
/// `ntfy_time` and `ntfy_id` together are the ordering authority (spec §4.3).
/// `seq` is local ingest order and is deliberately *not* an ordering key: two
/// devices that received the same events in the same ntfy order can still have
/// ingested them in different local orders after a reconnect or a backfill.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Event {
    pub seq: i64,
    pub ntfy_id: String,
    /// Unix seconds, as assigned by ntfy.
    pub ntfy_time: u64,
    pub message_id: String,
    pub msg_type: String,
    pub subject_id: Option<String>,
    /// The decrypted message JSON, verbatim.
    pub payload: String,
}

impl Event {
    /// The event's payload as JSON, or `Null` when it did not parse.
    ///
    /// Tolerant on purpose, in line with the wire types in `hitl-transport`: a
    /// payload this build cannot read is still a real event that happened, and
    /// dropping it would make the log lie about what arrived.
    pub fn json(&self) -> Value {
        serde_json::from_str(&self.payload).unwrap_or(Value::Null)
    }

    /// A string field off the payload, or `None` when absent or empty.
    pub fn field(&self, key: &str) -> Option<String> {
        self.json()
            .get(key)
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    }
}

/// What a message is *about* — the id every event concerning one exchange
/// shares, and the key the fold groups on.
///
/// The three request types are their own subject. That is not in spec §10's
/// column comment, which lists only the pointer fields the response types
/// carry, but it has to be true: `fold` is defined over "all events whose
/// subject is messageId", and a question with no answer has to fold to
/// `pending` from the question event alone.
pub fn subject_of(msg_type: &str, payload: &Value) -> Option<String> {
    let key = match msg_type {
        "answer" => "questionId",
        "plan_review_response" | "plan_review_ack" | "cancel_review" => "reviewId",
        "dismiss_notification" | "restore_notification" => "notificationId",
        "sender_identity" => "forMessageId",
        "question" | "notification" | "plan_review" => "messageId",
        // A type this build does not know still gets logged; it simply has no
        // subject to attach to, so it folds into nothing.
        _ => return None,
    };

    payload
        .get(key)
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

impl Store {
    /// Record one decrypted event. Returns its `seq`.
    ///
    /// `raw` is the decrypted message JSON — `event.message` is still whatever
    /// came off the wire, which for an encrypted topic is an envelope, not a
    /// message.
    ///
    /// Idempotent on `ntfy_id`: ntfy replays its cache window on every
    /// reconnect, so the same event arriving twice is the normal case, not an
    /// error. A second append returns the seq the first one got.
    pub fn append(&self, event: &NtfyEvent, raw: &str) -> Result<i64> {
        // Read before write, because on this path the write is almost always a
        // no-op. ntfy replays its whole cache window on every startup and every
        // reconnect, so a launch that learns two new events still calls this
        // several hundred times.
        //
        // `INSERT OR IGNORE` looks free when it ignores, and is not: SQLite
        // opens a write transaction for the statement and commits it whether or
        // not a row changed, which under WAL is an fsync each time. Measured on
        // the startup replay, that was 8.6 s of the cold path — and it is held
        // under the store mutex, so every one of those fsyncs is a moment the
        // window's own commands cannot reach the database. A click landing in
        // that window looks like a freeze, because it is one.
        //
        // The lookup is on a UNIQUE index and touches no lock at all.
        if let Some(seq) = self.seq_of(&event.id)? {
            return Ok(seq);
        }

        let payload: Value = serde_json::from_str(raw).unwrap_or(Value::Null);

        let msg_type = payload
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let message_id = payload
            .get("messageId")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let subject_id = subject_of(&msg_type, &payload);

        self.conn.execute(
            "INSERT OR IGNORE INTO events (ntfy_id, ntfy_time, message_id, type, subject_id, payload)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                event.id,
                event.time as i64,
                message_id,
                msg_type,
                subject_id,
                raw
            ],
        )?;

        // Re-read rather than trusting `last_insert_rowid`: two writers can
        // race here, and the loser's `OR IGNORE` must still return the seq the
        // winner wrote, not the rowid its own ignored statement never used.
        let seq: i64 = self.conn.query_row(
            "SELECT seq FROM events WHERE ntfy_id = ?1",
            params![event.id],
            |row| row.get(0),
        )?;
        Ok(seq)
    }

    /// The seq this ntfy id already has, if the log has seen it.
    fn seq_of(&self, ntfy_id: &str) -> Result<Option<i64>> {
        self.conn
            .query_row(
                "SELECT seq FROM events WHERE ntfy_id = ?1",
                params![ntfy_id],
                |row| row.get(0),
            )
            .optional()
    }

    /// Every event about `subject_id`, in ntfy order.
    ///
    /// Ordered here as well as in [`crate::fold`] so a caller that reads rows
    /// for display gets the same order the fold saw. The fold re-sorts anyway,
    /// because it also has to work on events that never went through a store.
    pub fn events_for(&self, subject_id: &str) -> Result<Vec<Event>> {
        let mut stmt = self.conn.prepare(
            "SELECT seq, ntfy_id, ntfy_time, message_id, type, subject_id, payload
             FROM events WHERE subject_id = ?1 ORDER BY ntfy_time, ntfy_id",
        )?;
        let rows = stmt.query_map(params![subject_id], row_to_event)?;
        rows.collect()
    }

    /// Highest local ingest sequence, or 0 when the log is empty.
    ///
    /// This is the `?since=` cursor for archivist backfill: local ingest order
    /// is exactly the right thing there, because it answers "what have I not
    /// been handed yet", not "what happened first".
    pub fn last_seq(&self) -> Result<i64> {
        let seq: Option<i64> = self
            .conn
            .query_row("SELECT max(seq) FROM events", [], |row| row.get(0))
            .optional()?
            .flatten();
        Ok(seq.unwrap_or(0))
    }

    /// Every event ingested after `seq`, in local ingest order.
    ///
    /// The read half of the cursor [`Store::last_seq`] describes: a consumer
    /// hands back the highest seq it holds and gets exactly what it has not
    /// been given yet. Ordered by `seq` — deliberately *not* by ntfy time —
    /// because the question here is "what is new to you", and an event
    /// backfilled today can carry a timestamp from last week.
    ///
    /// `limit` bounds one response; a caller that wants everything pages by
    /// passing the last seq it received back in.
    pub fn events_since(&self, seq: i64, limit: usize) -> Result<Vec<Event>> {
        let mut stmt = self.conn.prepare(
            "SELECT seq, ntfy_id, ntfy_time, message_id, type, subject_id, payload
             FROM events WHERE seq > ?1 ORDER BY seq LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![seq, limit as i64], row_to_event)?;
        rows.collect()
    }

    pub fn count_events(&self) -> Result<i64> {
        self.conn.query_row("SELECT count(*) FROM events", [], |row| row.get(0))
    }

    /// Every distinct subject the log knows about, in first-seen ntfy order.
    pub fn subjects(&self) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT subject_id FROM events WHERE subject_id IS NOT NULL
             GROUP BY subject_id ORDER BY min(ntfy_time), min(ntfy_id)",
        )?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        rows.collect()
    }
}

fn row_to_event(row: &rusqlite::Row<'_>) -> rusqlite::Result<Event> {
    Ok(Event {
        seq: row.get(0)?,
        ntfy_id: row.get(1)?,
        ntfy_time: row.get::<_, i64>(2)? as u64,
        message_id: row.get(3)?,
        msg_type: row.get(4)?,
        subject_id: row.get(5)?,
        payload: row.get(6)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds the ntfy envelope and the decrypted body together.
    ///
    /// They arrive as a pair in production too: `NtfyEvent` carries ntfy's id,
    /// time and attachment metadata, while `event.message` is still the
    /// encrypted envelope — the decrypted JSON is a separate string the caller
    /// already holds. So a test cannot supply one fixed `RAW` and vary the
    /// subject; the subject lives in the body.
    fn sample_event(ntfy_id: &str, subject: &str, msg_type: &str) -> (NtfyEvent, String) {
        let raw = match msg_type {
            "answer" => format!(
                r#"{{"type":"answer","questionId":"{subject}","respondedFrom":"phone",
                    "selectedValues":["yes"],"skipped":false}}"#
            ),
            _ => format!(r#"{{"type":"{msg_type}","messageId":"{subject}","question":"?"}}"#),
        };
        let event = NtfyEvent {
            id: ntfy_id.to_string(),
            // Descending in insert order for "ntfy-3" before "ntfy-1", so
            // ingest order and ntfy order genuinely disagree.
            time: if ntfy_id == "ntfy-3" { 300 } else { 100 },
            ..Default::default()
        };
        (event, raw)
    }

    #[test]
    fn append_is_idempotent_on_ntfy_id() {
        let s = Store::open_in_memory().unwrap();
        let (e, raw) = sample_event("ntfy-1", "msg-1", "question");
        s.append(&e, &raw).unwrap();
        s.append(&e, &raw).unwrap();
        assert_eq!(s.count_events().unwrap(), 1, "ntfy_id is UNIQUE");
    }

    #[test]
    fn events_for_a_subject_come_back_in_ntfy_order() {
        let s = Store::open_in_memory().unwrap();
        let (e3, raw3) = sample_event("ntfy-3", "m", "answer");
        s.append(&e3, &raw3).unwrap();
        let (e1, raw1) = sample_event("ntfy-1", "m", "question");
        s.append(&e1, &raw1).unwrap();

        let got: Vec<_> = s
            .events_for("m")
            .unwrap()
            .iter()
            .map(|e| e.ntfy_id.clone())
            .collect();

        assert_eq!(got, vec!["ntfy-1", "ntfy-3"], "order by ntfy time, not insert order");
    }

    #[test]
    fn a_re_appended_event_returns_the_seq_it_already_had() {
        // A reconnect replays ntfy's cache window, so this is the normal path.
        let s = Store::open_in_memory().unwrap();
        let (e, raw) = sample_event("ntfy-1", "msg-1", "question");
        assert_eq!(s.append(&e, &raw).unwrap(), s.append(&e, &raw).unwrap());
    }

    #[test]
    fn a_replayed_event_costs_the_log_nothing() {
        // The startup and reconnect cache replays re-append the whole ntfy
        // window, and almost none of it is new. `INSERT OR IGNORE` still opened
        // a write transaction and still consumed an AUTOINCREMENT rowid for
        // every one of those, so the counter advanced by hundreds on a launch
        // that learned nothing — and each of those was an fsync taken while
        // holding the store mutex the window needs to answer a click.
        //
        // The burned seq is the observable half of that, so assert on it: if a
        // replay ever writes again, the next genuinely new event will not land
        // where this expects.
        let s = Store::open_in_memory().unwrap();
        let (e1, raw1) = sample_event("ntfy-1", "m", "question");
        let first = s.append(&e1, &raw1).unwrap();

        for _ in 0..20 {
            assert_eq!(s.append(&e1, &raw1).unwrap(), first, "still idempotent");
        }

        let (e2, raw2) = sample_event("ntfy-2", "m", "answer");
        assert_eq!(
            s.append(&e2, &raw2).unwrap(),
            first + 1,
            "the replays consumed seqs a genuinely new event should have had"
        );
        assert_eq!(s.count_events().unwrap(), 2);
    }

    #[test]
    fn last_seq_is_zero_on_an_empty_log() {
        // The archivist backfill cursor. `max()` over no rows is NULL, and a
        // NULL read as i64 would be an error rather than "start from the top".
        let s = Store::open_in_memory().unwrap();
        assert_eq!(s.last_seq().unwrap(), 0);
    }

    #[test]
    fn events_since_returns_exactly_what_the_caller_has_not_seen() {
        // The archivist's `GET /events?since=` in miniature.
        let s = Store::open_in_memory().unwrap();
        let mut seqs = Vec::new();
        for id in ["n-1", "n-2", "n-3"] {
            let (e, raw) = sample_event(id, "m", "question");
            seqs.push(s.append(&e, &raw).unwrap());
        }

        let after_first: Vec<_> = s
            .events_since(seqs[0], 100)
            .unwrap()
            .iter()
            .map(|e| e.ntfy_id.clone())
            .collect();
        assert_eq!(after_first, vec!["n-2", "n-3"]);

        assert!(s.events_since(seqs[2], 100).unwrap().is_empty(), "nothing is newer");
        assert_eq!(s.events_since(0, 100).unwrap().len(), 3, "seq 0 means everything");
    }

    #[test]
    fn events_since_pages_in_ingest_order_not_ntfy_order() {
        // "ntfy-3" carries the *later* ntfy time but is ingested first, so a
        // backfill ordered by ntfy time would hand it back after "ntfy-1" and
        // a caller resuming from the last seq it saw would skip an event.
        let s = Store::open_in_memory().unwrap();
        let (e3, raw3) = sample_event("ntfy-3", "m", "answer");
        s.append(&e3, &raw3).unwrap();
        let (e1, raw1) = sample_event("ntfy-1", "m", "question");
        s.append(&e1, &raw1).unwrap();

        let got: Vec<_> = s
            .events_since(0, 100)
            .unwrap()
            .iter()
            .map(|e| e.ntfy_id.clone())
            .collect();
        assert_eq!(got, vec!["ntfy-3", "ntfy-1"]);

        let first_page = s.events_since(0, 1).unwrap();
        assert_eq!(first_page.len(), 1, "limit bounds one response");
        assert_eq!(first_page[0].ntfy_id, "ntfy-3");
    }

    #[test]
    fn every_response_type_points_at_the_subject_it_settles() {
        let cases = [
            (r#"{"type":"answer","questionId":"q-1"}"#, Some("q-1")),
            (r#"{"type":"plan_review_response","reviewId":"r-1"}"#, Some("r-1")),
            (r#"{"type":"plan_review_ack","reviewId":"r-1"}"#, Some("r-1")),
            (r#"{"type":"cancel_review","reviewId":"r-1"}"#, Some("r-1")),
            (r#"{"type":"dismiss_notification","notificationId":"n-1"}"#, Some("n-1")),
            (r#"{"type":"restore_notification","notificationId":"n-1","dismissalId":"d-1"}"#, Some("n-1")),
            (r#"{"type":"sender_identity","forMessageId":"q-1"}"#, Some("q-1")),
            (r#"{"type":"question","messageId":"q-1"}"#, Some("q-1")),
            (r#"{"type":"notification","messageId":"n-1"}"#, Some("n-1")),
            (r#"{"type":"plan_review","messageId":"r-1"}"#, Some("r-1")),
            // A type from a newer peer still gets logged, with no subject.
            (r#"{"type":"whatever","messageId":"x"}"#, None),
        ];

        for (raw, expected) in cases {
            let value: Value = serde_json::from_str(raw).unwrap();
            let msg_type = value.get("type").unwrap().as_str().unwrap();
            assert_eq!(
                subject_of(msg_type, &value).as_deref(),
                expected,
                "{raw}"
            );
        }
    }

    #[test]
    fn a_payload_this_build_cannot_read_is_still_logged() {
        // The log records what arrived. Refusing an unparseable body would
        // make it lie about the event stream, which is the one thing it is for.
        let s = Store::open_in_memory().unwrap();
        let event = NtfyEvent { id: "ntfy-9".to_string(), ..Default::default() };
        s.append(&event, "not json at all").unwrap();

        assert_eq!(s.count_events().unwrap(), 1);
    }
}
