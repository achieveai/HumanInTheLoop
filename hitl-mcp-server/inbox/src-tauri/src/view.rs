//! The projection layer: events in, the two panes out.
//!
//! Everything here is a pure function of `(events, now)`. There is no SQL, no
//! network and no clock — `now` arrives as an argument so a test can place a
//! session anywhere on the decay curve without waiting for it. That is also
//! why the Inbox folds in memory rather than reading `hitl_store`'s `messages`
//! table: that table cannot carry `session_key` (the crate leaves it NULL and
//! its connection is private), and a projection that is a function of its
//! inputs is worth more here than one query saved.

use std::collections::BTreeMap;

use hitl_store::{fold, Event, MessageState};
use serde::Serialize;

use crate::identity::{self, Identity};
use crate::session::{display_status, session_state, SessionState};

/// The pseudo-project holding messages whose `sender_identity` has not joined
/// yet (spec §5.5). Not a real project key, and prefixed so it can never
/// collide with a repo name.
pub const UNATTRIBUTED_KEY: &str = "__unattributed__";
pub const UNATTRIBUTED_NAME: &str = "Unattributed";

/// The message types a human is blocked on. A pending notification is not one:
/// nothing is waiting for it (spec §6.1).
fn blocks_an_agent(msg_type: &str) -> bool {
    matches!(msg_type, "question" | "plan_review")
}

/// Which renderer pane 3 will use, as one character (spec §7.1).
fn glyph_for(msg_type: &str) -> &'static str {
    match msg_type {
        "question" => "?",
        "notification" => "!",
        "plan_review" => "▤",
        _ => "·",
    }
}

/// The request event a subject is about — the one that gives it a title.
///
/// A subject can have none: ntfy's cache is a sliding window, so an answer can
/// outlive the question it settles. Such a subject gets no row, because there
/// is nothing truthful to put in one.
fn request_event(events: &[Event]) -> Option<&Event> {
    events.iter().find(|e| blocks_an_agent(&e.msg_type) || e.msg_type == "notification")
}

/// The one line that identifies a message (spec §7.1).
fn title_of(request: &Event) -> String {
    let json = request.json();
    let title = match request.msg_type.as_str() {
        "question" => {
            // Batch mode: the individual questions are pane 3's business, so
            // the row says how many there are rather than picking one.
            match json.get("questions").and_then(|q| q.as_array()) {
                Some(subs) if !subs.is_empty() => {
                    return if subs.len() == 1 {
                        "1 question".to_string()
                    } else {
                        format!("{} questions", subs.len())
                    }
                }
                _ => request.field("question"),
            }
        }
        "notification" => request.field("title"),
        _ => request.field("displayPath"),
    };
    title.unwrap_or_else(|| "(untitled)".to_string())
}

/// First ~80 characters of the agent's `context`, so you know why you were
/// asked (spec §7.1). Cut on a character boundary, never a byte one.
fn context_snippet(request: &Event) -> Option<String> {
    const LIMIT: usize = 80;
    let context = request.field("context")?;
    let trimmed = context.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut out: String = trimmed.chars().take(LIMIT).collect();
    if trimmed.chars().count() > LIMIT {
        out.push('…');
    }
    Some(out)
}

/// At-a-glance qualifiers (spec §7.1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Badges {
    /// `name · branch`, when the message carried a repo block.
    pub repo: Option<String>,
    /// `N` when `questions[]` is present.
    pub batch_count: Option<usize>,
    /// `r3` on plan reviews past the first.
    pub revision: Option<u64>,
    /// The plan body spilled to a ntfy attachment.
    pub attachment: bool,
    /// Whether the envelope was unencrypted — **`None` means unknown**, which
    /// is the honest answer today and always will be until the log records it.
    /// `Store::append` is handed the *decrypted* payload and nothing else;
    /// `was_encrypted` is a dispatch-time argument that never reaches a row.
    /// Modelled as an option rather than a permanently-`false` bool so the gap
    /// is visible in the type instead of being a quiet lie.
    pub plaintext: Option<bool>,
}

fn badges_of(request: &Event) -> Badges {
    let json = request.json();
    let repo = json.get("repo").and_then(|r| {
        let name = r.get("name").and_then(|v| v.as_str()).filter(|s| !s.is_empty())?;
        match r.get("branch").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
            Some(branch) => Some(format!("{name} · {branch}")),
            None => Some(name.to_string()),
        }
    });

    Badges {
        repo,
        batch_count: json
            .get("questions")
            .and_then(|q| q.as_array())
            .map(|a| a.len())
            .filter(|n| *n > 0),
        revision: json
            .get("revision")
            .and_then(|v| v.as_u64())
            .filter(|r| *r > 1),
        attachment: json
            .get("body")
            .and_then(|b| b.get("kind"))
            .and_then(|v| v.as_str())
            == Some("attachment"),
        plaintext: None,
    }
}

/// One row of pane 2 — a header, and nothing else. No body, no controls: those
/// are pane 3's job (spec §7).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRow {
    pub message_id: String,
    /// `question` | `notification` | `plan_review`.
    pub msg_type: String,
    pub glyph: &'static str,
    pub title: String,
    /// The §7.2 vocabulary, `stale` included.
    pub status: String,
    /// Sub-label on an answered plan review: `approved` / `changes_requested`
    /// / `rejected` / `skipped` / `cancelled`.
    pub verdict: Option<String>,
    /// ntfy time of the request event, in unix seconds. Absolute, for hover.
    pub created_at: u64,
    /// Relative age against the `now` the view was built with.
    pub age_seconds: u64,
    /// Who closed it and from which device. Blank while pending.
    pub responder: Option<String>,
    pub responded_at: Option<u64>,
    pub context_snippet: Option<String>,
    pub badges: Badges,
    pub session_key: Option<String>,
    pub session_label: Option<String>,
    pub project_key: String,
    pub unattributed: bool,
}

/// One subject, resolved. Internal: the shape both panes are derived from.
struct Subject {
    row: MessageRow,
    /// The folded status, before `stale` is overlaid. Counting pending off
    /// this rather than off `row.status` is what stops the overlay from
    /// depending on itself.
    folded_status: String,
    last_event_at: u64,
    identity: Option<Identity>,
}

fn build_subject(events: &[Event], now: u64) -> Option<Subject> {
    let request = request_event(events)?;
    let state: MessageState = fold(events);
    let identity = identity::resolve(request, events);
    let last_event_at = events.iter().map(|e| e.ntfy_time).max().unwrap_or(request.ntfy_time);

    Some(Subject {
        row: MessageRow {
            message_id: request.message_id.clone(),
            msg_type: request.msg_type.clone(),
            glyph: glyph_for(&request.msg_type),
            title: title_of(request),
            status: state.status.as_str().to_string(),
            verdict: state.verdict.map(|v| v.as_str().to_string()),
            created_at: request.ntfy_time,
            age_seconds: now.saturating_sub(request.ntfy_time),
            responder: state.responder.clone(),
            responded_at: state.responded_at,
            context_snippet: context_snippet(request),
            badges: badges_of(request),
            session_key: identity.as_ref().map(|i| i.session_key.clone()),
            session_label: identity.as_ref().map(|i| i.session_label.clone()),
            project_key: identity
                .as_ref()
                .map(|i| i.project_key.clone())
                .unwrap_or_else(|| UNATTRIBUTED_KEY.to_string()),
            unattributed: identity.is_none(),
        },
        folded_status: state.status.as_str().to_string(),
        last_event_at,
        identity,
    })
}

/// Group a flat event log by the subject each event is about.
///
/// `BTreeMap` rather than a hash map so the grouping order is deterministic,
/// which keeps the tie-break in the sort below reproducible.
fn group_by_subject(events: &[Event]) -> BTreeMap<String, Vec<Event>> {
    let mut grouped: BTreeMap<String, Vec<Event>> = BTreeMap::new();
    for event in events {
        if let Some(subject) = &event.subject_id {
            grouped.entry(subject.clone()).or_default().push(event.clone());
        }
    }
    grouped
}

// ---------------------------------------------------------------------------
// Pane 1 — the agent tree
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    pub session_key: String,
    pub label: String,
    pub project_key: String,
    /// What `list_messages` should be handed to select this row. The UI never
    /// composes one of these; it passes back what the tree gave it.
    pub scope_key: String,
    /// `waiting` | `active` | `idle` | `stale` (spec §6.1).
    pub state: &'static str,
    pub glyph: &'static str,
    /// Blocking pending only — questions and plan reviews.
    pub pending_count: u32,
    pub message_count: u32,
    pub last_event_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectNode {
    pub project_key: String,
    pub name: String,
    pub scope_key: String,
    pub state: &'static str,
    pub glyph: &'static str,
    pub pending_count: u32,
    pub message_count: u32,
    pub last_event_at: u64,
    pub sessions: Vec<SessionRow>,
    /// True for the one `Unattributed` node, which has no sessions because its
    /// messages have no session to belong to yet.
    pub unattributed: bool,
}

/// What `list_sessions()` returns.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTree {
    /// Most recent activity first. The `Unattributed` node, when present, is
    /// always last regardless of its age — it is a waiting room, not a project.
    pub projects: Vec<ProjectNode>,
    /// The "All agents" root row (spec §6).
    pub total_pending: u32,
    pub total_messages: u32,
    /// The scope key of the "All agents" root.
    pub scope_key: &'static str,
    /// The clock every `state` and every age in this tree was computed against,
    /// so a caller can render relative times without re-reading it.
    pub now: u64,
}

/// Accumulates one session's or one project's counters.
#[derive(Default)]
struct Counters {
    pending: u32,
    messages: u32,
    last_event_at: u64,
}

impl Counters {
    fn add(&mut self, subject: &Subject) {
        self.messages += 1;
        if subject.folded_status == "pending" && blocks_an_agent(&subject.row.msg_type) {
            self.pending += 1;
        }
        self.last_event_at = self.last_event_at.max(subject.last_event_at);
    }

    fn state(&self, now: u64) -> SessionState {
        // A group with no events at all reads as maximally old rather than as
        // fresh — `session_state` folds that onto `stale`.
        let age = if self.last_event_at == 0 {
            u64::MAX
        } else {
            now.saturating_sub(self.last_event_at)
        };
        session_state(self.pending, age)
    }
}

/// Build the agent tree (spec §6).
pub fn build_tree(events: &[Event], now: u64) -> SessionTree {
    let subjects: Vec<Subject> = group_by_subject(events)
        .values()
        .filter_map(|e| build_subject(e, now))
        .collect();

    // project -> session -> counters. `""` is the session slot of the
    // Unattributed node, which never renders a session row.
    let mut projects: BTreeMap<String, BTreeMap<String, Counters>> = BTreeMap::new();
    let mut labels: BTreeMap<String, String> = BTreeMap::new();
    let mut total = Counters::default();

    for subject in &subjects {
        total.add(subject);
        let (project, session) = match &subject.identity {
            Some(id) => {
                labels.insert(id.session_key.clone(), id.session_label.clone());
                (id.project_key.clone(), id.session_key.clone())
            }
            None => (UNATTRIBUTED_KEY.to_string(), String::new()),
        };
        projects
            .entry(project)
            .or_default()
            .entry(session)
            .or_default()
            .add(subject);
    }

    let mut nodes: Vec<ProjectNode> = projects
        .into_iter()
        .map(|(project_key, sessions)| {
            let unattributed = project_key == UNATTRIBUTED_KEY;
            let mut rolled = Counters::default();
            let mut rows: Vec<SessionRow> = Vec::new();

            for (session_key, counters) in sessions {
                rolled.pending += counters.pending;
                rolled.messages += counters.messages;
                rolled.last_event_at = rolled.last_event_at.max(counters.last_event_at);

                if unattributed {
                    continue;
                }
                let state = counters.state(now);
                rows.push(SessionRow {
                    label: labels
                        .get(&session_key)
                        .cloned()
                        .unwrap_or_else(|| session_key.clone()),
                    scope_key: format!("session:{session_key}"),
                    session_key,
                    project_key: project_key.clone(),
                    state: state.as_str(),
                    glyph: state.glyph(),
                    pending_count: counters.pending,
                    message_count: counters.messages,
                    last_event_at: counters.last_event_at,
                });
            }

            rows.sort_by(|a, b| {
                b.last_event_at
                    .cmp(&a.last_event_at)
                    .then_with(|| a.label.cmp(&b.label))
            });

            let state = rolled.state(now);
            ProjectNode {
                name: if unattributed {
                    UNATTRIBUTED_NAME.to_string()
                } else {
                    project_key.clone()
                },
                scope_key: if unattributed {
                    "unattributed".to_string()
                } else {
                    format!("project:{project_key}")
                },
                project_key,
                state: state.as_str(),
                glyph: state.glyph(),
                pending_count: rolled.pending,
                message_count: rolled.messages,
                last_event_at: rolled.last_event_at,
                sessions: rows,
                unattributed,
            }
        })
        .collect();

    // Most recent activity first (spec §6), with `Unattributed` pinned last:
    // it is a waiting room every message passes through, so letting it float
    // to the top on recency would put it above the projects on every arrival.
    nodes.sort_by(|a, b| {
        a.unattributed.cmp(&b.unattributed).then_with(|| {
            b.last_event_at
                .cmp(&a.last_event_at)
                .then_with(|| a.name.cmp(&b.name))
        })
    });

    SessionTree {
        projects: nodes,
        total_pending: total.pending,
        total_messages: total.messages,
        scope_key: "all",
        now,
    }
}

// ---------------------------------------------------------------------------
// Pane 2 — the message list
// ---------------------------------------------------------------------------

/// Which rows a scope key selects. Produced by [`build_tree`], consumed by
/// [`build_list`]; the UI only ever passes one back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Scope {
    All,
    Project(String),
    Session(String),
    Unattributed,
}

/// An unrecognised or absent scope means "everything", never an error: a stale
/// selection left over from a session that has since scrolled out of the log
/// should show you the whole Inbox, not an empty pane.
pub fn parse_scope(raw: Option<&str>) -> Scope {
    match raw.map(str::trim).filter(|s| !s.is_empty()) {
        None | Some("all") => Scope::All,
        Some("unattributed") => Scope::Unattributed,
        Some(other) => match other.split_once(':') {
            Some(("project", key)) => Scope::Project(key.to_string()),
            Some(("session", key)) => Scope::Session(key.to_string()),
            _ => Scope::All,
        },
    }
}

impl Scope {
    fn admits(&self, row: &MessageRow) -> bool {
        match self {
            Self::All => true,
            Self::Unattributed => row.unattributed,
            Self::Project(key) => &row.project_key == key,
            Self::Session(key) => row.session_key.as_deref() == Some(key.as_str()),
        }
    }
}

/// The pinned filters of spec §7.3.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Filter {
    All,
    /// Anything still on you — `pending`, and `stale` because a decayed
    /// pending is still unanswered.
    NeedsYou,
    /// Everything settled, however it settled.
    Answered,
    Notifications,
}

impl Filter {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::NeedsYou => "needs_you",
            Self::Answered => "answered",
            Self::Notifications => "notifications",
        }
    }

    fn admits(self, row: &MessageRow) -> bool {
        let open = row.status == "pending" || row.status == "stale";
        match self {
            Self::All => true,
            Self::NeedsYou => open,
            // Defined as the complement of `needs_you` rather than as a list of
            // statuses, so a status added later cannot fall through both and
            // become invisible in every filter but `All`.
            Self::Answered => !open,
            Self::Notifications => row.msg_type == "notification",
        }
    }
}

pub fn parse_filter(raw: Option<&str>) -> Option<Filter> {
    match raw.map(str::trim).filter(|s| !s.is_empty())? {
        "all" => Some(Filter::All),
        "needs_you" => Some(Filter::NeedsYou),
        "answered" => Some(Filter::Answered),
        "notifications" => Some(Filter::Notifications),
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterCounts {
    pub all: u32,
    pub needs_you: u32,
    pub answered: u32,
    pub notifications: u32,
}

/// What `list_messages()` returns.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageList {
    /// Newest first.
    pub messages: Vec<MessageRow>,
    /// Counts over the *scope*, before the filter — so the filter bar can show
    /// what each tab would contain rather than what the current one does.
    pub counts: FilterCounts,
    /// The filter actually applied, after defaulting.
    pub filter: &'static str,
    /// What an absent filter resolves to: `needs_you` when anything in scope is
    /// pending, `all` otherwise (spec §7.3).
    pub default_filter: &'static str,
    pub scope_key: String,
    pub now: u64,
}

/// Build the message list (spec §7).
///
/// `filter` of `None` means "you pick" and lands on the §7.3 default. An
/// unrecognised filter string is treated the same way rather than returning an
/// error, for the same reason `parse_scope` is forgiving.
pub fn build_list(events: &[Event], scope_key: Option<&str>, filter: Option<&str>, now: u64) -> MessageList {
    let scope = parse_scope(scope_key);

    let mut rows: Vec<MessageRow> = group_by_subject(events)
        .values()
        .filter_map(|e| build_subject(e, now))
        .map(|subject| subject.row)
        .filter(|row| scope.admits(row))
        .collect();

    // `stale` needs the owning session's state, which needs every subject in
    // that session — including ones this scope filtered out. So it is applied
    // from a tree built over the whole log, not over the scoped rows.
    let tree = build_tree(events, now);
    for row in &mut rows {
        row.status = display_status(&row.status, state_for(&tree, row)).to_string();
    }

    let counts = FilterCounts {
        all: rows.len() as u32,
        needs_you: rows.iter().filter(|r| Filter::NeedsYou.admits(r)).count() as u32,
        answered: rows.iter().filter(|r| Filter::Answered.admits(r)).count() as u32,
        notifications: rows.iter().filter(|r| Filter::Notifications.admits(r)).count() as u32,
    };

    let default_filter = if counts.needs_you > 0 { Filter::NeedsYou } else { Filter::All };
    let applied = parse_filter(filter).unwrap_or(default_filter);

    rows.retain(|row| applied.admits(row));
    // Newest first (spec §7), by the request's ntfy time. The message id breaks
    // ties so a repaint never reorders two messages published in the same
    // second.
    rows.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| a.message_id.cmp(&b.message_id))
    });

    MessageList {
        messages: rows,
        counts,
        filter: applied.as_str(),
        default_filter: default_filter.as_str(),
        scope_key: scope_key.unwrap_or("all").to_string(),
        now,
    }
}

/// The state of the session (or project) a row belongs to.
fn state_for(tree: &SessionTree, row: &MessageRow) -> SessionState {
    let node = tree.projects.iter().find(|p| p.project_key == row.project_key);
    let state = match (&row.session_key, node) {
        (Some(key), Some(node)) => node
            .sessions
            .iter()
            .find(|s| &s.session_key == key)
            .map(|s| s.state),
        // An unattributed message has no session, so the pseudo-project's own
        // rolled-up state is the only thing that can speak for it.
        (None, Some(node)) => Some(node.state),
        _ => None,
    };
    match state {
        Some("waiting") => SessionState::Waiting,
        Some("active") => SessionState::Active,
        Some("stale") => SessionState::Stale,
        _ => SessionState::Idle,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fixed clock. Every age below is a distance from it, so no test here
    /// depends on when it runs.
    const NOW: u64 = 1_786_600_000;
    const MINUTE: u64 = 60;
    const HOUR: u64 = 60 * 60;
    const DAY: u64 = 24 * HOUR;

    /// One log row, with its subject derived exactly the way `Store::append`
    /// derives it — so a test can never disagree with ingest about what an
    /// event is about.
    fn ev(ntfy_id: &str, time: u64, payload: &str) -> Event {
        let json: serde_json::Value =
            serde_json::from_str(payload).expect("test payload must be json");
        let msg_type = json
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        Event {
            seq: 0,
            ntfy_id: ntfy_id.to_string(),
            ntfy_time: time,
            message_id: json
                .get("messageId")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
            subject_id: hitl_store::events::subject_of(&msg_type, &json),
            msg_type,
            payload: payload.to_string(),
        }
    }

    fn question(id: &str, at: u64, repo: &str) -> Event {
        ev(
            &format!("ntfy-{id}"),
            at,
            &format!(
                r#"{{"type":"question","messageId":"{id}","question":"Proceed with {id}?",
                     "context":"why you are being asked",
                     "repo":{{"name":"{repo}","branch":"master"}}}}"#
            ),
        )
    }

    fn identity(id: &str, at: u64, label: &str) -> Event {
        ev(
            &format!("ntfy-{id}-ident"),
            at,
            &format!(
                r#"{{"type":"sender_identity","forMessageId":"{id}","forType":"question",
                     "sender":{{"label":"{label}","source":"session"}}}}"#
            ),
        )
    }

    fn answer(id: &str, at: u64, from: &str) -> Event {
        ev(
            &format!("ntfy-{id}-ans"),
            at,
            &format!(
                r#"{{"type":"answer","messageId":"a-{id}","questionId":"{id}",
                     "respondedFrom":"{from}","selectedValues":["yes"],"skipped":false}}"#
            ),
        )
    }

    fn notification(id: &str, at: u64, title: &str) -> Event {
        ev(
            &format!("ntfy-{id}"),
            at,
            &format!(
                r#"{{"type":"notification","messageId":"{id}","title":"{title}","body":"done"}}"#
            ),
        )
    }

    fn project_names(tree: &SessionTree) -> Vec<&str> {
        tree.projects.iter().map(|p| p.name.as_str()).collect()
    }

    fn project<'a>(tree: &'a SessionTree, name: &str) -> &'a ProjectNode {
        tree.projects
            .iter()
            .find(|p| p.name == name)
            .unwrap_or_else(|| panic!("no project {name} in {:?}", project_names(tree)))
    }

    fn ids(list: &MessageList) -> Vec<&str> {
        list.messages.iter().map(|m| m.message_id.as_str()).collect()
    }

    // --- Pane 1: the tree ---

    #[test]
    fn the_tree_is_two_levels_project_then_session() {
        let events = vec![
            question("q-1", NOW - MINUTE, "Hitl_MCP"),
            identity("q-1", NOW - MINUTE, "Hitl_MCP · master · a3f2"),
            question("q-2", NOW - 2 * MINUTE, "Hitl_MCP"),
            identity("q-2", NOW - 2 * MINUTE, "Hitl_MCP · feat/inbox · 9c81"),
            notification("n-1", NOW - 3 * MINUTE, "built"),
            identity("n-1", NOW - 3 * MINUTE, "mcqdb-api · main · 7b1e"),
        ];

        let tree = build_tree(&events, NOW);

        assert_eq!(project_names(&tree), vec!["Hitl_MCP", "mcqdb-api"]);
        assert_eq!(
            project(&tree, "Hitl_MCP")
                .sessions
                .iter()
                .map(|s| s.label.as_str())
                .collect::<Vec<_>>(),
            vec!["master · a3f2", "feat/inbox · 9c81"],
            "sessions sort by most recent activity"
        );
    }

    #[test]
    fn projects_sort_by_most_recent_activity() {
        let events = vec![
            question("q-1", NOW - 10 * MINUTE, "older"),
            identity("q-1", NOW - 10 * MINUTE, "older · master · aaaa"),
            question("q-2", NOW - MINUTE, "newer"),
            identity("q-2", NOW - MINUTE, "newer · master · bbbb"),
        ];

        assert_eq!(project_names(&build_tree(&events, NOW)), vec!["newer", "older"]);
    }

    #[test]
    fn a_sessions_last_event_includes_the_answer_not_just_the_question() {
        // Sorting on the request time alone would freeze a session at the
        // moment it last *asked* something, so a session answering steadily
        // would sink below one silent since it asked.
        let events = vec![
            question("q-1", NOW - HOUR, "busy"),
            identity("q-1", NOW - HOUR, "busy · master · aaaa"),
            answer("q-1", NOW - MINUTE, "laptop"),
            question("q-2", NOW - 30 * MINUTE, "quiet"),
            identity("q-2", NOW - 30 * MINUTE, "quiet · master · bbbb"),
            answer("q-2", NOW - 29 * MINUTE, "laptop"),
        ];

        assert_eq!(project_names(&build_tree(&events, NOW)), vec!["busy", "quiet"]);
    }

    #[test]
    fn a_session_with_a_pending_question_is_waiting() {
        let events = vec![
            question("q-1", NOW - HOUR, "Hitl_MCP"),
            identity("q-1", NOW - HOUR, "Hitl_MCP · master · a3f2"),
        ];

        let tree = build_tree(&events, NOW);
        let session = &project(&tree, "Hitl_MCP").sessions[0];
        assert_eq!(session.state, "waiting");
        assert_eq!(session.glyph, "●");
        assert_eq!(session.pending_count, 1);
    }

    #[test]
    fn an_undismissed_notification_does_not_make_a_session_waiting() {
        // Spec §6.1 says "blocks the agent". Nothing is blocked on a
        // notification, so one sitting undismissed for a week must not light
        // the whole project up as though someone were waiting on you.
        let events = vec![
            notification("n-1", NOW - MINUTE, "built"),
            identity("n-1", NOW - MINUTE, "Hitl_MCP · master · a3f2"),
        ];

        let tree = build_tree(&events, NOW);
        let session = &project(&tree, "Hitl_MCP").sessions[0];
        assert_eq!(session.state, "active");
        assert_eq!(session.pending_count, 0);
        assert_eq!(session.message_count, 1);
    }

    #[test]
    fn an_answered_session_that_has_been_quiet_is_idle_then_stale() {
        let quiet = |age: u64| {
            vec![
                question("q-1", NOW - age - MINUTE, "Hitl_MCP"),
                identity("q-1", NOW - age - MINUTE, "Hitl_MCP · master · a3f2"),
                answer("q-1", NOW - age, "laptop"),
            ]
        };

        assert_eq!(project(&build_tree(&quiet(HOUR), NOW), "Hitl_MCP").sessions[0].state, "idle");
        assert_eq!(project(&build_tree(&quiet(2 * DAY), NOW), "Hitl_MCP").sessions[0].state, "stale");
    }

    #[test]
    fn a_project_rolls_up_the_pending_counts_of_its_sessions() {
        let events = vec![
            question("q-1", NOW - MINUTE, "Hitl_MCP"),
            identity("q-1", NOW - MINUTE, "Hitl_MCP · master · a3f2"),
            question("q-2", NOW - 2 * MINUTE, "Hitl_MCP"),
            identity("q-2", NOW - 2 * MINUTE, "Hitl_MCP · feat/inbox · 9c81"),
        ];

        let tree = build_tree(&events, NOW);
        let hitl = project(&tree, "Hitl_MCP");
        assert_eq!(hitl.pending_count, 2);
        assert_eq!(hitl.message_count, 2);
        assert_eq!(hitl.state, "waiting");
        assert_eq!(tree.total_pending, 2, "and so does the All agents root");
        assert_eq!(tree.total_messages, 2);
    }

    #[test]
    fn a_subject_with_no_request_event_gets_no_row_anywhere() {
        // An answer can outlive the question it settles once ntfy's window
        // slides past it. There is nothing truthful to title such a row with.
        let tree = build_tree(&[answer("gone", NOW - MINUTE, "phone")], NOW);

        assert!(tree.projects.is_empty());
        assert_eq!(tree.total_messages, 0);
    }

    // --- Unattributed (spec §5.5) ---

    #[test]
    fn a_message_whose_identity_has_not_joined_lands_in_unattributed() {
        let tree = build_tree(&[question("q-1", NOW - MINUTE, "Hitl_MCP")], NOW);

        assert_eq!(project_names(&tree), vec![UNATTRIBUTED_NAME]);
        let node = project(&tree, UNATTRIBUTED_NAME);
        assert!(node.unattributed);
        assert_eq!(node.message_count, 1);
        assert_eq!(node.pending_count, 1);
        assert!(node.sessions.is_empty(), "it has no session to belong to yet");
        assert_eq!(node.scope_key, "unattributed");
    }

    #[test]
    fn a_message_moves_out_of_unattributed_when_its_identity_lands() {
        // The whole point of §5.5: the UI never sees the race. Same message,
        // one more event, and the group it was in disappears entirely.
        let mut events = vec![question("q-1", NOW - MINUTE, "Hitl_MCP")];
        assert_eq!(project_names(&build_tree(&events, NOW)), vec![UNATTRIBUTED_NAME]);

        events.push(identity("q-1", NOW - MINUTE, "Hitl_MCP · master · a3f2"));

        let tree = build_tree(&events, NOW);
        assert_eq!(project_names(&tree), vec!["Hitl_MCP"]);
        assert_eq!(project(&tree, "Hitl_MCP").sessions[0].label, "master · a3f2");
    }

    #[test]
    fn identity_arriving_before_the_message_it_decorates_joins_just_the_same() {
        // `sender_identity` is a separate message with no delivery-order
        // guarantee; a backfill can hand it over first.
        let events = vec![
            identity("q-1", NOW - 2 * MINUTE, "Hitl_MCP · master · a3f2"),
            question("q-1", NOW - MINUTE, "Hitl_MCP"),
        ];

        assert_eq!(project_names(&build_tree(&events, NOW)), vec!["Hitl_MCP"]);
    }

    #[test]
    fn unattributed_stays_last_even_when_it_is_the_most_recent_thing() {
        // Every question passes through this group on its way in. Sorting it
        // on recency would put it at the top of the tree on every arrival,
        // which is the opposite of a waiting room.
        let events = vec![
            question("q-1", NOW - HOUR, "Hitl_MCP"),
            identity("q-1", NOW - HOUR, "Hitl_MCP · master · a3f2"),
            question("q-2", NOW, "Hitl_MCP"),
        ];

        assert_eq!(
            project_names(&build_tree(&events, NOW)),
            vec!["Hitl_MCP", UNATTRIBUTED_NAME]
        );
    }

    #[test]
    fn only_the_message_still_missing_identity_sits_in_unattributed() {
        let events = vec![
            question("q-1", NOW - MINUTE, "Hitl_MCP"),
            identity("q-1", NOW - MINUTE, "Hitl_MCP · master · a3f2"),
            question("q-2", NOW - 2 * MINUTE, "Hitl_MCP"),
        ];

        let tree = build_tree(&events, NOW);
        assert_eq!(project(&tree, "Hitl_MCP").message_count, 1);
        assert_eq!(project(&tree, UNATTRIBUTED_NAME).message_count, 1);

        let list = build_list(&events, Some("unattributed"), Some("all"), NOW);
        assert_eq!(ids(&list), vec!["q-2"]);
        assert!(list.messages[0].unattributed);
        assert!(list.messages[0].session_key.is_none());
    }

    // --- Pane 2: headers (spec §7.1) ---

    #[test]
    fn a_single_question_is_titled_by_its_question_text() {
        let row = &build_list(&[question("q-1", NOW - MINUTE, "Hitl_MCP")], None, Some("all"), NOW)
            .messages[0];

        assert_eq!(row.title, "Proceed with q-1?");
        assert_eq!(row.glyph, "?");
        assert_eq!(row.msg_type, "question");
    }

    #[test]
    fn a_batch_question_is_titled_by_how_many_it_asks() {
        let events = [ev(
            "ntfy-1",
            NOW - MINUTE,
            r#"{"type":"question","messageId":"q-1","question":"ignored in batch mode",
                "questions":[{"question":"a"},{"question":"b"},{"question":"c"}]}"#,
        )];

        let row = &build_list(&events, None, Some("all"), NOW).messages[0];
        assert_eq!(row.title, "3 questions");
        assert_eq!(row.badges.batch_count, Some(3));
    }

    #[test]
    fn a_batch_of_one_is_not_pluralised() {
        let events = [ev(
            "ntfy-1",
            NOW,
            r#"{"type":"question","messageId":"q-1","question":"x","questions":[{"question":"a"}]}"#,
        )];

        assert_eq!(build_list(&events, None, Some("all"), NOW).messages[0].title, "1 question");
    }

    #[test]
    fn a_notification_is_titled_by_its_title_and_a_plan_review_by_its_display_path() {
        let events = [
            notification("n-1", NOW - MINUTE, "Build Complete"),
            ev(
                "ntfy-p1",
                NOW - 2 * MINUTE,
                r#"{"type":"plan_review","messageId":"p-1","displayPath":"docs/plans/inbox.md",
                    "revision":3,"context":"review this",
                    "body":{"kind":"attachment","contentHash":"sha256:ab","contentLength":9},
                    "repo":{"name":"Hitl_MCP","branch":"design/llm-inbox"},
                    "sender":{"label":"Hitl_MCP · design/llm-inbox · 9c81","source":"session"}}"#,
            ),
        ];

        let list = build_list(&events, None, Some("all"), NOW);
        let note = list.messages.iter().find(|m| m.msg_type == "notification").unwrap();
        let review = list.messages.iter().find(|m| m.msg_type == "plan_review").unwrap();

        assert_eq!(note.title, "Build Complete");
        assert_eq!(note.glyph, "!");
        assert_eq!(review.title, "docs/plans/inbox.md");
        assert_eq!(review.glyph, "▤");
        assert_eq!(review.badges.revision, Some(3));
        assert!(review.badges.attachment);
        assert_eq!(review.badges.repo.as_deref(), Some("Hitl_MCP · design/llm-inbox"));
    }

    #[test]
    fn a_first_revision_carries_no_revision_badge() {
        let events = [ev(
            "ntfy-p1",
            NOW,
            r#"{"type":"plan_review","messageId":"p-1","displayPath":"docs/p.md","revision":1}"#,
        )];

        assert_eq!(build_list(&events, None, Some("all"), NOW).messages[0].badges.revision, None);
    }

    #[test]
    fn a_row_reports_who_closed_it_and_when() {
        let events = [
            question("q-1", NOW - HOUR, "Hitl_MCP"),
            answer("q-1", NOW - MINUTE, "Kay9 laptop"),
        ];

        let row = &build_list(&events, None, Some("all"), NOW).messages[0];
        assert_eq!(row.status, "answered");
        assert_eq!(row.responder.as_deref(), Some("Kay9 laptop"));
        assert_eq!(row.responded_at, Some(NOW - MINUTE));
    }

    #[test]
    fn a_pending_row_names_no_responder() {
        let row =
            &build_list(&[question("q-1", NOW - MINUTE, "Hitl_MCP")], None, Some("all"), NOW)
                .messages[0];

        assert_eq!(row.status, "pending");
        assert_eq!(row.responder, None);
        assert_eq!(row.responded_at, None);
    }

    #[test]
    fn an_answered_plan_review_carries_its_verdict_as_a_sub_label() {
        let events = [
            ev(
                "ntfy-p1",
                NOW - HOUR,
                r#"{"type":"plan_review","messageId":"p-1","displayPath":"docs/p.md"}"#,
            ),
            ev(
                "ntfy-p1-resp",
                NOW - MINUTE,
                r#"{"type":"plan_review_response","messageId":"r-1","reviewId":"p-1",
                    "verdict":"changes_requested","respondedFrom":"laptop"}"#,
            ),
        ];

        let row = &build_list(&events, None, Some("all"), NOW).messages[0];
        assert_eq!(row.status, "answered");
        assert_eq!(row.verdict.as_deref(), Some("changes_requested"));
    }

    #[test]
    fn the_age_is_measured_from_the_requests_ntfy_time() {
        let row =
            &build_list(&[question("q-1", NOW - 90 * MINUTE, "Hitl_MCP")], None, Some("all"), NOW)
                .messages[0];

        assert_eq!(row.created_at, NOW - 90 * MINUTE);
        assert_eq!(row.age_seconds, 90 * MINUTE);
    }

    #[test]
    fn a_message_from_a_clock_ahead_of_ours_reads_as_zero_rather_than_underflowing() {
        let events = [question("q-1", NOW + HOUR, "Hitl_MCP")];
        assert_eq!(build_list(&events, None, Some("all"), NOW).messages[0].age_seconds, 0);
    }

    fn snippet_of(context: &str) -> Option<String> {
        let events = [ev(
            "ntfy-1",
            NOW,
            &format!(
                r#"{{"type":"question","messageId":"q-1","question":"?","context":"{context}"}}"#
            ),
        )];
        build_list(&events, None, Some("all"), NOW).messages[0]
            .context_snippet
            .clone()
    }

    #[test]
    fn the_context_snippet_is_clipped_to_eighty_characters() {
        let snippet = snippet_of(&"x".repeat(200)).expect("a context was given");

        assert_eq!(snippet.chars().count(), 81, "80 characters plus the ellipsis");
        assert!(snippet.ends_with('…'));
    }

    #[test]
    fn a_multibyte_context_is_cut_on_a_character_boundary() {
        // Slicing this by bytes would panic rather than truncate.
        assert_eq!(snippet_of(&"é".repeat(200)).unwrap().chars().count(), 81);
    }

    #[test]
    fn a_context_shorter_than_the_limit_is_shown_whole_with_no_ellipsis() {
        assert_eq!(snippet_of("short reason").as_deref(), Some("short reason"));
    }

    #[test]
    fn a_message_with_no_context_has_no_snippet() {
        // `context` is optional on Notify, so this is the ordinary case.
        let events = [notification("n-1", NOW, "built")];
        assert_eq!(build_list(&events, None, Some("all"), NOW).messages[0].context_snippet, None);
    }

    #[test]
    fn the_plaintext_badge_is_unknown_rather_than_false() {
        // The log records the decrypted payload and never records whether the
        // envelope was encrypted. `None` says so; `false` would claim we
        // checked and found it encrypted.
        let events = [question("q-1", NOW, "Hitl_MCP")];
        assert_eq!(build_list(&events, None, Some("all"), NOW).messages[0].badges.plaintext, None);
    }

    // --- Pane 2: stale, scope, filters ---

    #[test]
    fn a_pending_message_in_a_stale_session_reads_stale() {
        // The overlay the fold deliberately refuses to compute.
        let events = [
            question("q-1", NOW - 3 * DAY, "Hitl_MCP"),
            identity("q-1", NOW - 3 * DAY, "Hitl_MCP · master · a3f2"),
        ];

        assert_eq!(build_list(&events, None, Some("all"), NOW).messages[0].status, "stale");
    }

    #[test]
    fn an_answered_message_in_a_stale_session_stays_answered() {
        let events = [
            question("q-1", NOW - 3 * DAY, "Hitl_MCP"),
            identity("q-1", NOW - 3 * DAY, "Hitl_MCP · master · a3f2"),
            answer("q-1", NOW - 3 * DAY + MINUTE, "laptop"),
        ];

        assert_eq!(build_list(&events, None, Some("all"), NOW).messages[0].status, "answered");
    }

    #[test]
    fn staleness_is_judged_over_the_whole_session_not_the_selected_scope() {
        // The session is alive — it asked something a minute ago — so the old
        // question in it is `pending`, not `stale`. Deriving the state from
        // only the rows a scope admitted would get this backwards the moment
        // anyone selected a narrower scope.
        let events = [
            question("q-old", NOW - 3 * DAY, "Hitl_MCP"),
            identity("q-old", NOW - 3 * DAY, "Hitl_MCP · master · a3f2"),
            question("q-new", NOW - MINUTE, "Hitl_MCP"),
            identity("q-new", NOW - MINUTE, "Hitl_MCP · master · a3f2"),
        ];

        let list = build_list(&events, Some("session:Hitl_MCP · master · a3f2"), Some("all"), NOW);
        assert_eq!(list.messages.len(), 2);
        assert!(list.messages.iter().all(|m| m.status == "pending"));
    }

    #[test]
    fn a_scope_selects_a_session_a_project_or_everything() {
        let events = [
            question("q-1", NOW - MINUTE, "Hitl_MCP"),
            identity("q-1", NOW - MINUTE, "Hitl_MCP · master · a3f2"),
            question("q-2", NOW - 2 * MINUTE, "Hitl_MCP"),
            identity("q-2", NOW - 2 * MINUTE, "Hitl_MCP · feat/inbox · 9c81"),
            question("q-3", NOW - 3 * MINUTE, "mcqdb-api"),
            identity("q-3", NOW - 3 * MINUTE, "mcqdb-api · main · 7b1e"),
        ];
        let scoped = |scope: Option<&str>| {
            build_list(&events, scope, Some("all"), NOW)
                .messages
                .iter()
                .map(|m| m.message_id.clone())
                .collect::<Vec<_>>()
        };

        assert_eq!(scoped(Some("session:Hitl_MCP · master · a3f2")), vec!["q-1"]);
        assert_eq!(scoped(Some("project:Hitl_MCP")), vec!["q-1", "q-2"]);
        assert_eq!(scoped(Some("all")), vec!["q-1", "q-2", "q-3"]);
        assert_eq!(scoped(None), vec!["q-1", "q-2", "q-3"]);
    }

    #[test]
    fn a_scope_key_that_no_longer_matches_anything_shows_everything() {
        // A selection can outlive the session it named once ntfy's window
        // slides. An empty pane would read as "no messages"; the whole Inbox
        // reads as "that agent is gone", which is the truth.
        assert_eq!(parse_scope(Some("nonsense")), Scope::All);
        let events = [question("q-1", NOW, "Hitl_MCP")];
        assert_eq!(build_list(&events, Some("nonsense"), Some("all"), NOW).messages.len(), 1);
    }

    #[test]
    fn the_list_is_newest_first() {
        let events = [
            question("q-old", NOW - 3 * HOUR, "Hitl_MCP"),
            question("q-new", NOW - MINUTE, "Hitl_MCP"),
            question("q-mid", NOW - HOUR, "Hitl_MCP"),
        ];

        assert_eq!(
            ids(&build_list(&events, None, Some("all"), NOW)),
            vec!["q-new", "q-mid", "q-old"]
        );
    }

    #[test]
    fn needs_you_is_the_default_when_anything_is_pending() {
        let events = [
            question("q-1", NOW - MINUTE, "Hitl_MCP"),
            question("q-2", NOW - 2 * MINUTE, "Hitl_MCP"),
            answer("q-2", NOW - MINUTE, "laptop"),
        ];

        let list = build_list(&events, None, None, NOW);
        assert_eq!(list.default_filter, "needs_you");
        assert_eq!(list.filter, "needs_you");
        assert_eq!(ids(&list), vec!["q-1"]);
    }

    #[test]
    fn all_is_the_default_when_nothing_is_pending() {
        let events = [
            question("q-1", NOW - 2 * MINUTE, "Hitl_MCP"),
            answer("q-1", NOW - MINUTE, "laptop"),
        ];

        let list = build_list(&events, None, None, NOW);
        assert_eq!(list.default_filter, "all");
        assert_eq!(list.filter, "all");
        assert_eq!(list.messages.len(), 1);
    }

    #[test]
    fn a_stale_message_still_counts_as_needing_you() {
        // It decayed; nobody answered it. Dropping it out of `Needs you` would
        // hide the exact orphan §16.5 is about.
        let list = build_list(&[question("q-1", NOW - 3 * DAY, "Hitl_MCP")], None, None, NOW);

        assert_eq!(list.messages[0].status, "stale");
        assert_eq!(list.filter, "needs_you");
        assert_eq!(list.counts.needs_you, 1);
    }

    #[test]
    fn the_four_filters_partition_the_scope_the_way_the_tabs_claim() {
        let events = [
            question("q-1", NOW - MINUTE, "Hitl_MCP"),
            question("q-2", NOW - 2 * MINUTE, "Hitl_MCP"),
            answer("q-2", NOW - MINUTE, "laptop"),
            notification("n-1", NOW - 3 * MINUTE, "built"),
        ];
        let count = |filter: &str| build_list(&events, None, Some(filter), NOW).messages.len();

        assert_eq!(count("all"), 3);
        assert_eq!(count("needs_you"), 2, "the open question and the undismissed notification");
        assert_eq!(count("answered"), 1);
        assert_eq!(count("notifications"), 1);

        assert_eq!(
            build_list(&events, None, Some("all"), NOW).counts,
            FilterCounts { all: 3, needs_you: 2, answered: 1, notifications: 1 }
        );
    }

    #[test]
    fn needs_you_and_answered_are_complements() {
        // Defined that way on purpose: a status invented later must land in one
        // of the two rather than vanishing from both.
        let events = [
            question("q-1", NOW - MINUTE, "Hitl_MCP"),
            question("q-2", NOW - 2 * MINUTE, "Hitl_MCP"),
            answer("q-2", NOW - MINUTE, "laptop"),
            question("q-3", NOW - 3 * MINUTE, "Hitl_MCP"),
            ev(
                "ntfy-q3-skip",
                NOW - 2 * MINUTE,
                r#"{"type":"answer","messageId":"a-3","questionId":"q-3","respondedFrom":"phone",
                    "selectedValues":[],"skipped":true}"#,
            ),
            notification("n-1", NOW - 4 * MINUTE, "built"),
            ev(
                "ntfy-n1-dis",
                NOW - 3 * MINUTE,
                r#"{"type":"dismiss_notification","messageId":"d-1","notificationId":"n-1",
                    "dismissedFrom":"laptop"}"#,
            ),
        ];

        let counts = build_list(&events, None, Some("all"), NOW).counts;
        assert_eq!(counts.needs_you + counts.answered, counts.all);
        assert_eq!(counts.all, 4);
    }

    #[test]
    fn the_counts_describe_the_scope_not_the_applied_filter() {
        // The filter bar has to be able to say what the other tabs hold.
        let events = [
            question("q-1", NOW - MINUTE, "Hitl_MCP"),
            question("q-2", NOW - 2 * MINUTE, "Hitl_MCP"),
            answer("q-2", NOW - MINUTE, "laptop"),
        ];

        let list = build_list(&events, None, Some("answered"), NOW);
        assert_eq!(list.messages.len(), 1);
        assert_eq!(list.counts.all, 2);
        assert_eq!(list.counts.needs_you, 1);
    }

    #[test]
    fn an_unrecognised_filter_falls_back_to_the_default_rather_than_erroring() {
        assert_eq!(parse_filter(Some("nope")), None);
        let events = [question("q-1", NOW, "Hitl_MCP")];
        assert_eq!(build_list(&events, None, Some("nope"), NOW).filter, "needs_you");
    }

    #[test]
    fn the_view_echoes_the_clock_it_was_built_with() {
        // Pane 2 renders relative ages client-side; handing back `now` is what
        // keeps its arithmetic and this module's `status` agreeing.
        let events = [question("q-1", NOW, "Hitl_MCP")];
        assert_eq!(build_list(&events, None, None, NOW).now, NOW);
        assert_eq!(build_tree(&events, NOW).now, NOW);
    }

    #[test]
    fn an_empty_log_produces_an_empty_but_well_formed_view() {
        let tree = build_tree(&[], NOW);
        assert!(tree.projects.is_empty());
        assert_eq!(tree.total_pending, 0);
        assert_eq!(tree.scope_key, "all");

        let list = build_list(&[], None, None, NOW);
        assert!(list.messages.is_empty());
        assert_eq!(list.filter, "all", "nothing pending, so nothing to default to");
        assert_eq!(
            list.counts,
            FilterCounts { all: 0, needs_you: 0, answered: 0, notifications: 0 }
        );
    }

    fn keys(value: &serde_json::Value) -> Vec<String> {
        let mut keys: Vec<String> = value
            .as_object()
            .expect("an object")
            .keys()
            .cloned()
            .collect();
        keys.sort();
        keys
    }

    #[test]
    fn the_json_the_panes_receive_is_camel_case_and_complete() {
        // The webview and the Playwright fixtures are written against these
        // exact names, and nothing in JS would fail loudly if one changed —
        // a renamed field just reads `undefined` and the row draws blank. This
        // is the only thing standing between a serde rename and a silently
        // empty pane.
        let events = [
            question("q-1", NOW - MINUTE, "Hitl_MCP"),
            identity("q-1", NOW - MINUTE, "Hitl_MCP · master · a3f2"),
        ];

        let tree = serde_json::to_value(build_tree(&events, NOW)).unwrap();
        assert_eq!(keys(&tree), ["now", "projects", "scopeKey", "totalMessages", "totalPending"]);
        assert_eq!(
            keys(&tree["projects"][0]),
            [
                "glyph",
                "lastEventAt",
                "messageCount",
                "name",
                "pendingCount",
                "projectKey",
                "scopeKey",
                "sessions",
                "state",
                "unattributed"
            ]
        );
        assert_eq!(
            keys(&tree["projects"][0]["sessions"][0]),
            [
                "glyph",
                "label",
                "lastEventAt",
                "messageCount",
                "pendingCount",
                "projectKey",
                "scopeKey",
                "sessionKey",
                "state"
            ]
        );

        let list = serde_json::to_value(build_list(&events, None, None, NOW)).unwrap();
        assert_eq!(
            keys(&list),
            ["counts", "defaultFilter", "filter", "messages", "now", "scopeKey"]
        );
        assert_eq!(keys(&list["counts"]), ["all", "answered", "needsYou", "notifications"]);
        assert_eq!(
            keys(&list["messages"][0]),
            [
                "ageSeconds",
                "badges",
                "contextSnippet",
                "createdAt",
                "glyph",
                "messageId",
                "msgType",
                "projectKey",
                "respondedAt",
                "responder",
                "sessionKey",
                "sessionLabel",
                "status",
                "title",
                "unattributed",
                "verdict"
            ]
        );
        assert_eq!(
            keys(&list["messages"][0]["badges"]),
            ["attachment", "batchCount", "plaintext", "repo", "revision"]
        );
    }

    #[test]
    fn the_tree_scope_keys_are_exactly_what_list_messages_accepts() {
        // The UI never composes a scope key; it hands back what the tree gave
        // it. This is the contract that lets it.
        let events = [
            question("q-1", NOW - MINUTE, "Hitl_MCP"),
            identity("q-1", NOW - MINUTE, "Hitl_MCP · master · a3f2"),
            question("q-2", NOW - 2 * MINUTE, "Hitl_MCP"),
        ];
        let tree = build_tree(&events, NOW);

        for node in &tree.projects {
            let list = build_list(&events, Some(&node.scope_key), Some("all"), NOW);
            assert_eq!(list.messages.len() as u32, node.message_count, "{}", node.scope_key);
            for session in &node.sessions {
                let list = build_list(&events, Some(&session.scope_key), Some("all"), NOW);
                assert_eq!(list.messages.len() as u32, session.message_count);
            }
        }
        assert_eq!(
            build_list(&events, Some(tree.scope_key), Some("all"), NOW).messages.len() as u32,
            tree.total_messages
        );
    }
}
