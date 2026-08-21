//! The projection: the fold, written down.
//!
//! Everything here is derived and droppable. Nothing in `messages` is consulted
//! to decide anything — it exists so the list pane can be drawn with one query
//! instead of re-folding every subject on every repaint. [`Store::rebuild`] is
//! the proof: if this table can always be thrown away and regenerated from
//! `events`, then no stored status can ever have drifted from what was
//! observed.

use rusqlite::params;

use crate::events::Event;
use crate::fold::fold;
use crate::{Result, Store};

/// The request event a subject is *about* — the one that gives it a title.
///
/// A subject can legitimately have none: ntfy's cache is a sliding window, so a
/// response can outlive the request it answers. Such a subject is not
/// projected, because there is nothing truthful to show in a row for it.
fn request_event(events: &[Event]) -> Option<&Event> {
    events
        .iter()
        .find(|e| matches!(e.msg_type.as_str(), "question" | "notification" | "plan_review"))
}

/// The one line that identifies a message in the list (spec §7.1).
fn title_of(request: &Event) -> String {
    let key = match request.msg_type.as_str() {
        "question" => "question",
        "notification" => "title",
        _ => "displayPath",
    };
    request.field(key).unwrap_or_default()
}

impl Store {
    /// Re-derive the `messages` row for one subject. Returns whether a row was
    /// written — `false` means the log holds responses but not the request.
    pub fn project_subject(&self, subject_id: &str) -> Result<bool> {
        let events = self.events_for(subject_id)?;
        let Some(request) = request_event(&events) else {
            return Ok(false);
        };
        let state = fold(&events);
        let repo = request.json();
        let repo = repo.get("repo");

        self.conn.execute(
            "INSERT INTO messages (message_id, type, session_key, project_key, created_at,
                                   status, verdict, responder, responded_at, title, context,
                                   repo_name, repo_branch)
             VALUES (?1, ?2, NULL, NULL, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(message_id) DO UPDATE SET
               type = excluded.type,
               created_at = excluded.created_at,
               status = excluded.status,
               verdict = excluded.verdict,
               responder = excluded.responder,
               responded_at = excluded.responded_at,
               title = excluded.title,
               context = excluded.context,
               repo_name = excluded.repo_name,
               repo_branch = excluded.repo_branch",
            params![
                subject_id,
                request.msg_type,
                request.ntfy_time as i64,
                state.status.as_str(),
                state.verdict.map(|v| v.as_str()),
                state.responder,
                state.responded_at.map(|t| t as i64),
                title_of(request),
                request.field("context"),
                repo.and_then(|r| r.get("name")).and_then(|v| v.as_str()),
                repo.and_then(|r| r.get("branch")).and_then(|v| v.as_str()),
            ],
        )?;
        Ok(true)
    }

    /// Throw the projection away and rebuild it from the log.
    ///
    /// `session_key` and `project_key` stay NULL here; joining sender identity
    /// onto a message is the Inbox's job and lands with the agents pane.
    pub fn rebuild(&self) -> Result<usize> {
        self.conn.execute("DELETE FROM messages", [])?;
        let mut written = 0;
        for subject in self.subjects()? {
            if self.project_subject(&subject)? {
                written += 1;
            }
        }
        Ok(written)
    }

    /// The folded status recorded for a message, if it has been projected.
    pub fn projected_status(&self, message_id: &str) -> Result<Option<String>> {
        use rusqlite::OptionalExtension;
        self.conn
            .query_row(
                "SELECT status FROM messages WHERE message_id = ?1",
                params![message_id],
                |row| row.get(0),
            )
            .optional()
    }
}

#[cfg(test)]
mod tests {
    use hitl_transport::ntfy::subscribe::NtfyEvent;

    use crate::Store;

    fn ntfy(id: &str, time: u64) -> NtfyEvent {
        NtfyEvent {
            id: id.to_string(),
            time,
            ..Default::default()
        }
    }

    #[test]
    fn a_projected_row_carries_the_folded_status_not_a_stored_one() {
        let s = Store::open_in_memory().unwrap();
        s.append(
            &ntfy("n-1", 1),
            r#"{"type":"question","messageId":"q-1","question":"Proceed?","context":"ctx",
                "repo":{"name":"Hitl","branch":"master"}}"#,
        )
        .unwrap();
        s.project_subject("q-1").unwrap();
        assert_eq!(s.projected_status("q-1").unwrap().as_deref(), Some("pending"));

        s.append(
            &ntfy("n-2", 5),
            r#"{"type":"answer","questionId":"q-1","respondedFrom":"phone",
                "selectedValues":["yes"],"skipped":false}"#,
        )
        .unwrap();
        s.project_subject("q-1").unwrap();

        assert_eq!(s.projected_status("q-1").unwrap().as_deref(), Some("answered"));
    }

    #[test]
    fn the_projection_is_droppable_and_rebuilds_identically() {
        // The invariant in schema.rs, executed. If this ever fails, something
        // authoritative has leaked out of `events` and into `messages`.
        let s = Store::open_in_memory().unwrap();
        s.append(&ntfy("n-1", 1), r#"{"type":"notification","messageId":"m-1","title":"done"}"#)
            .unwrap();
        s.append(
            &ntfy("n-2", 5),
            r#"{"type":"dismiss_notification","notificationId":"m-1","dismissedFrom":"phone"}"#,
        )
        .unwrap();

        assert_eq!(s.rebuild().unwrap(), 1);
        let first = s.projected_status("m-1").unwrap();
        assert_eq!(s.rebuild().unwrap(), 1);

        assert_eq!(first.as_deref(), Some("dismissed"));
        assert_eq!(s.projected_status("m-1").unwrap(), first);
    }

    #[test]
    fn a_response_whose_request_fell_out_of_the_cache_is_not_projected() {
        // ntfy's window is a sliding 12 h. A row with no request event behind
        // it would have no honest title, so it gets none at all.
        let s = Store::open_in_memory().unwrap();
        s.append(
            &ntfy("n-1", 5),
            r#"{"type":"answer","questionId":"gone","respondedFrom":"phone",
                "selectedValues":["yes"],"skipped":false}"#,
        )
        .unwrap();

        assert!(!s.project_subject("gone").unwrap());
        assert_eq!(s.rebuild().unwrap(), 0);
    }
}
