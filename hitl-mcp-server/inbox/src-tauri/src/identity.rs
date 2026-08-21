//! Who sent a message, and which project it belongs to.
//!
//! The Inbox's own identity routing. `decide_sender_identity_action` in
//! `hitl-client` is not reusable here: it decides between emitting to a window
//! label and caching for one, and a window label is a desktop-client concept.
//! The Inbox has no windows to route to — it has a tree to group by — so what
//! it needs is a *derivation*, not a routing decision, and everything below is
//! a pure function over the events that actually arrived.
//!
//! ## Why the project key is derived rather than read
//!
//! `server/src/identity.ts` computes a proper `project_key` from
//! `CLAUDE_PROJECT_DIR` (spec §5.4) — and then never puts it on the wire.
//! `SenderIdentity` is `{label, source}` and nothing else, and Global
//! Constraints forbid adding a field to it. So the project a session belongs
//! to has to be recovered from what does arrive: the `repo` block on the
//! message, or failing that the shape of the session-tier label itself,
//! `<repoName> · <branch> · <first-4-of-uuid>`.
//!
//! `NotificationMessage` carries no `repo` at all, which is precisely why the
//! label fallback has to exist rather than being a nicety.

use hitl_store::Event;

/// The separator `composeSessionLabel` joins a session-tier label with.
const LABEL_SEP: &str = " · ";

/// Everything the agent tree needs to know about one message's sender.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    /// Stable for the life of one MCP server process — one Claude Code
    /// session — because that is what the label is minted from (spec §5.3).
    /// The label *is* the key: the minted UUID itself never reaches the wire.
    pub session_key: String,
    /// What the session row shows, with the project prefix stripped so the
    /// tree does not repeat the project name on every child (spec §6).
    pub session_label: String,
    pub project_key: String,
}

/// The sender label carried by, or attached to, one subject's events.
///
/// Two sources, checked in that order:
/// - `plan_review.sender` — inline, and therefore never late (spec §5.5);
/// - a `sender_identity` event, which is a *separate* message correlated by
///   `forMessageId` and can arrive late, out of order, or never.
///
/// `None` is the ordinary early state of every question and notification, not
/// an error — it is what puts a message in `Unattributed` until the sibling
/// lands.
pub fn sender_label(events: &[Event]) -> Option<String> {
    events
        .iter()
        .find_map(|e| match e.msg_type.as_str() {
            "plan_review" | "sender_identity" => e
                .json()
                .get("sender")
                .and_then(|s| s.get("label"))
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(str::to_string),
            _ => None,
        })
}

/// The repo name a request event advertises, if any.
pub fn repo_name(request: &Event) -> Option<String> {
    request
        .json()
        .get("repo")
        .and_then(|r| r.get("name"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Which project a label belongs to.
///
/// A session-tier label is `<repoName> · <branch> · <id4>`, so its first
/// segment is the project. A worktree-tier (`<device> - <branch>`) or
/// path-tier (`<device> <a/b>`) label has no project inside it, and inventing
/// one by splitting on something else would produce a tree that regroups
/// itself whenever the identity tier changes. Those group under their own
/// whole label instead — honest, and stable.
pub fn project_of_label(label: &str) -> String {
    let segments: Vec<&str> = label.split(LABEL_SEP).collect();
    if segments.len() >= 3 && !segments[0].is_empty() {
        segments[0].to_string()
    } else {
        label.to_string()
    }
}

/// The session row's own text, with the project prefix removed.
///
/// `Hitl_MCP · master · a3f2` under project `Hitl_MCP` reads `master · a3f2`,
/// matching spec §6's tree. A label that does not start with the project is
/// left alone rather than being trimmed by position.
pub fn session_label_under(label: &str, project: &str) -> String {
    let prefix = format!("{project}{LABEL_SEP}");
    label.strip_prefix(&prefix).unwrap_or(label).to_string()
}

/// Resolve one subject's identity, or `None` while it is unattributed.
///
/// `request` supplies the repo block; `events` supplies the label. Both come
/// from the same subject, and neither is consulted for anything else.
pub fn resolve(request: &Event, events: &[Event]) -> Option<Identity> {
    let label = sender_label(events)?;
    // The repo block is preferred over the label because it is the sender's own
    // statement of where it is, whereas the label's first segment is only a
    // segment that usually happens to be the repo name.
    let project_key = repo_name(request).unwrap_or_else(|| project_of_label(&label));
    Some(Identity {
        session_label: session_label_under(&label, &project_key),
        project_key,
        session_key: label,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(msg_type: &str, payload: &str) -> Event {
        Event {
            seq: 1,
            ntfy_id: "n-1".to_string(),
            ntfy_time: 100,
            message_id: "m-1".to_string(),
            msg_type: msg_type.to_string(),
            subject_id: Some("q-1".to_string()),
            payload: payload.to_string(),
        }
    }

    fn question(repo: &str) -> Event {
        event(
            "question",
            &format!(
                r#"{{"type":"question","messageId":"q-1","question":"Proceed?",
                     "repo":{{"name":"{repo}","branch":"master"}}}}"#
            ),
        )
    }

    fn identity_event(label: &str) -> Event {
        event(
            "sender_identity",
            &format!(
                r#"{{"type":"sender_identity","forMessageId":"q-1","forType":"question",
                     "sender":{{"label":"{label}","source":"session"}}}}"#
            ),
        )
    }

    #[test]
    fn a_question_with_no_identity_event_yet_has_no_identity() {
        let q = question("Hitl_MCP");
        assert_eq!(resolve(&q, std::slice::from_ref(&q)), None);
    }

    #[test]
    fn a_sender_identity_event_supplies_the_session_key() {
        let q = question("Hitl_MCP");
        let events = vec![q.clone(), identity_event("Hitl_MCP · master · a3f2")];

        assert_eq!(
            resolve(&q, &events),
            Some(Identity {
                session_key: "Hitl_MCP · master · a3f2".to_string(),
                session_label: "master · a3f2".to_string(),
                project_key: "Hitl_MCP".to_string(),
            })
        );
    }

    #[test]
    fn a_plan_review_needs_no_join_because_it_carries_its_sender_inline() {
        // Spec §5.5: plan_review is the one type that never passes through
        // Unattributed.
        let review = event(
            "plan_review",
            r#"{"type":"plan_review","messageId":"p-1","displayPath":"docs/plan.md",
                "repo":{"name":"Hitl_MCP","branch":"design/llm-inbox"},
                "sender":{"label":"Hitl_MCP · design/llm-inbox · 9c81","source":"session"}}"#,
        );

        let resolved = resolve(&review, std::slice::from_ref(&review)).expect("inline sender");
        assert_eq!(resolved.project_key, "Hitl_MCP");
        assert_eq!(resolved.session_label, "design/llm-inbox · 9c81");
    }

    #[test]
    fn a_notification_with_no_repo_block_takes_its_project_from_the_label() {
        // NotificationMessage has no `repo` field at all, so the label is the
        // only thing that can put it under the right project.
        let notification = event(
            "notification",
            r#"{"type":"notification","messageId":"n-1","title":"Build complete","body":"ok"}"#,
        );
        let events = vec![notification.clone(), identity_event("mcqdb-api · main · 7b1e")];

        let resolved = resolve(&notification, &events).expect("identity landed");
        assert_eq!(resolved.project_key, "mcqdb-api");
        assert_eq!(resolved.session_label, "main · 7b1e");
    }

    #[test]
    fn a_worktree_tier_label_groups_under_itself_rather_than_being_split() {
        // `<device> - <branch>` has no project inside it. Splitting it anyway
        // would make the tree reshuffle the moment the identity tier changed.
        assert_eq!(
            project_of_label("Kay9 - work-item/1-reviewplan"),
            "Kay9 - work-item/1-reviewplan"
        );
        assert_eq!(project_of_label("Kay9 sources/Hitl_MCP"), "Kay9 sources/Hitl_MCP");
    }

    #[test]
    fn a_label_whose_branch_contains_the_separator_still_yields_the_repo() {
        // Branch names can contain almost anything; only the first segment is
        // load-bearing, so more segments than expected must not break it.
        assert_eq!(project_of_label("Hitl_MCP · feat · odd · branch · a3f2"), "Hitl_MCP");
    }

    #[test]
    fn the_repo_block_outranks_the_label_when_the_two_disagree() {
        // The label is composed from CLAUDE_PROJECT_DIR, which can point at a
        // different directory than the plan's own repo. The repo block is the
        // sender's direct statement and wins.
        let q = question("real-repo");
        let events = vec![q.clone(), identity_event("other-name · master · a3f2")];

        let resolved = resolve(&q, &events).expect("identity landed");
        assert_eq!(resolved.project_key, "real-repo");
        // No prefix to strip, so the label stays whole rather than being cut.
        assert_eq!(resolved.session_label, "other-name · master · a3f2");
    }

    #[test]
    fn an_empty_label_is_treated_as_no_identity_at_all() {
        // An empty string would otherwise become a project named "" — a tree
        // row with no name that nothing can be attributed to.
        let q = question("Hitl_MCP");
        let events = vec![q.clone(), identity_event("")];
        assert_eq!(resolve(&q, &events), None);
    }

    #[test]
    fn the_first_identity_event_wins_when_a_replay_delivers_two() {
        let q = question("Hitl_MCP");
        let events = vec![
            q.clone(),
            identity_event("Hitl_MCP · master · a3f2"),
            identity_event("Hitl_MCP · master · a3f2"),
        ];
        assert_eq!(resolve(&q, &events).unwrap().session_key, "Hitl_MCP · master · a3f2");
    }
}
