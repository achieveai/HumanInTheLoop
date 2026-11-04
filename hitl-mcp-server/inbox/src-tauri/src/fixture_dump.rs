//! Records a real fixture for `inbox-harness.html` out of the live
//! `~/.hitl/inbox.db` event log.
//!
//! The harness comment promises the fixture is "a *recording of what the Rust
//! commands return*, never a reimplementation of them". This module keeps
//! that promise for a browser session that has no Playwright init script:
//! it drives the very same `Projection`, `detail::build_detail` and
//! `body::decode` the Tauri commands use, then writes what they returned to
//! `src/harness-fixture.json`, which `http-server` exposes next to the app.
//!
//! Regenerate after the log grows:
//!
//! ```sh
//! cargo test --release --lib dump_harness_fixture -- --exact --nocapture
//! ```
//!
//! It is a `#[test]` rather than a bin target because every module it reads
//! (`view`, `detail`, `body`, `settings`) is private to the crate; a bin or
//! example could not reach them without widening the crate's API surface.
#![cfg(test)]

use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use hitl_store::{BodyStatus, Store};

use crate::body::{self, BodyOutcome};
use crate::detail;
use crate::settings;
use crate::view::Projection;

const PAGE_SIZE: usize = 1000;
/// Pane 2 draws a hundred rows; the fixture keeps a few pages so every scope
/// has room to scroll without the file ballooning with whole histories.
const MAX_ROWS_PER_LIST: usize = 500;

fn hitl_dir() -> PathBuf {
    dirs::home_dir()
        .expect("home dir")
        .join(".hitl")
}

/// The projection works in whole seconds (lib.rs `now_secs`). Handing it
/// milliseconds ages every message ~56,000 years: the recency cut hides
/// the whole log and everything decays to `stale`.
fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn load_events(store: &Store) -> Vec<hitl_store::Event> {
    let mut out = Vec::new();
    let mut cursor = 0_i64;
    loop {
        let page = store
            .events_since(cursor, PAGE_SIZE)
            .expect("read the event log");
        let Some(last) = page.last() else { break };
        cursor = last.seq;
        out.extend(page);
    }
    out
}

/// The same fold every pane reads, brought up to the whole log.
fn projection_over(store: &Store) -> Projection {
    let mut projection = Projection::default();
    projection.extend(load_events(store));
    projection
}

/// What the archivist-facing statuses become in a fixture that never asks
/// the archivist: the UI branches on the same closed vocabulary the real
/// `get_body` produces.
fn missing_outcome(status: BodyStatus) -> BodyOutcome {
    match status {
        BodyStatus::Corrupt { actual_hash, detail, .. } => BodyOutcome::Missing {
            status: "corrupt".to_string(),
            detail,
            reason: actual_hash,
        },
        BodyStatus::Gone { detail, .. } => BodyOutcome::Missing {
            status: "gone".to_string(),
            detail,
            reason: None,
        },
        BodyStatus::Undecryptable { detail, .. } => BodyOutcome::Missing {
            status: "undecryptable".to_string(),
            detail,
            reason: None,
        },
        BodyStatus::Unknown { reason, detail, .. } => BodyOutcome::Missing {
            status: "unknown".to_string(),
            detail,
            reason: Some(reason),
        },
        // Verified never reaches here (that means the bytes are in `bodies`,
        // and the caller resolves those first); anything newer than this
        // build is reported, not guessed at.
        other => BodyOutcome::Missing {
            status: format!("{other:?}").to_lowercase(),
            detail: None,
            reason: None,
        },
    }
}

/// Resolve one plan review's body the way `body::load` does, minus the
/// archivist round trip: inline bodies decode from the event itself, captured
/// bodies come out of our own `bodies` table (stored as the plaintext preimage
/// of their hash, so no key is needed), and only a recorded failure stands in
/// for "nowhere this process can reach".
fn resolve_body(store: &Store, key: Option<&str>, request: &hitl_store::Event) -> Option<BodyOutcome> {
    let reference = body::body_ref(request)?;
    if reference.content_hash.is_empty() {
        return Some(BodyOutcome::Undecodable {
            kind: "corrupt".to_string(),
            detail: "the plan reference carries no contentHash to verify against".to_string(),
        });
    }
    if reference.kind == "inline" {
        return Some(match reference.data.as_deref() {
            Some(data) => body::decode(data, key, &reference.content_hash),
            None => BodyOutcome::Undecodable {
                kind: "missing".to_string(),
                detail: "the plan said its body was inline and carried none".to_string(),
            },
        });
    }
    Some(match store.get_body(&reference.content_hash) {
        Ok(Some(bytes)) => match String::from_utf8(bytes) {
            Ok(plaintext) => body::decode(&plaintext, None, &reference.content_hash),
            Err(_) => BodyOutcome::Undecodable {
                kind: "corrupt".to_string(),
                detail: "the captured body is not utf-8".to_string(),
            },
        },
        Ok(None) => match store.body_status(&reference.content_hash) {
            Ok(status) => missing_outcome(status),
            Err(_) => BodyOutcome::Unreachable {
                detail: "fixture dump could not read the body failure log".to_string(),
            },
        },
        Err(_) => BodyOutcome::Unreachable {
            detail: "fixture dump could not read the captured bodies".to_string(),
        },
    })
}

#[test]
#[ignore = "exports local Inbox history; run explicitly only"]
fn dump_harness_fixture() {
    let dir = hitl_dir();
    let store = Store::open(dir.join("inbox.db")).expect("open ~/.hitl/inbox.db");
    let now = now_secs();

    let mut projection = projection_over(&store);
    let tree = projection.tree(now);

    let mut scopes: Vec<String> = vec!["all".to_string(), "unattributed".to_string()];
    for project in &tree.projects {
        scopes.push(project.scope_key.clone());
        scopes.extend(project.sessions.iter().map(|s| s.scope_key.clone()));
    }

    // Every (scope, filter) pair pane 2 can ask for, plus each scope's
    // default-filter answer under "<scope>|null" and the bare-list fallback
    // under "default".
    let mut lists = serde_json::Map::new();
    let mut seen_ids: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for scope in &scopes {
        for filter in ["all", "needs_you", "answered", "notifications"] {
            let mut list = projection.list(Some(scope), Some(filter), now);
            list.messages.truncate(MAX_ROWS_PER_LIST);
            for row in &list.messages {
                if seen.insert(row.message_id.clone()) {
                    seen_ids.push(row.message_id.clone());
                }
            }
            lists.insert(
                format!("{scope}|{filter}"),
                serde_json::to_value(&list).expect("serialize MessageList"),
            );
        }
        let default = projection.list(Some(scope), None, now);
        lists.insert(
            format!("{scope}|null"),
            serde_json::to_value(&default).expect("serialize default MessageList"),
        );
    }
    let all_all = projection.list(None, Some("all"), now);
    lists.insert(
        "default".to_string(),
        serde_json::to_value(&projection.list(None, None, now)).expect("serialize default scope"),
    );

    // A detail for every message the lists can show, exactly as the
    // `get_message` command returns it: the all-agents list first, then the
    // whole-history row lookup that lets settled threads open. Anything the
    // recording cannot expand is a harness bug, not a fixture shortcut.
    let key = hitl_transport::config::load_config()
        .ok()
        .and_then(|config| config.encryption_key);
    let mut details = serde_json::Map::new();
    for id in &seen_ids {
        let message = detail::build_detail(projection.events(), &all_all, id).or_else(|| {
            projection
                .row_for(id, now)
                .and_then(|row| detail::build_detail_with_row(projection.events(), row, id))
        });
        if let Some(message) = message {
            details.insert(id.clone(), serde_json::to_value(&message).expect("serialize MessageDetail"));
        }
    }

    // A body for every plan review in the log, not just the recent few —
    // expanding a settled review in the harness must show the real plan.
    let mut bodies = serde_json::Map::new();
    let review_requests: Vec<&hitl_store::Event> = projection
        .events()
        .iter()
        .filter(|e| e.msg_type == "plan_review")
        .collect();
    for request in review_requests {
        if let Some(outcome) = resolve_body(&store, key.as_deref(), request) {
            bodies.insert(request.message_id.clone(), serde_json::to_value(&outcome).expect("serialize BodyOutcome"));
        }
    }

    let connection = settings::load_public_at(&dir, false).expect("read ~/.hitl/config.json");

    let fixture = serde_json::json!({
        "generatedAt": now,
        "settings": connection,
        "sessions": tree,
        "messages": lists,
        "details": details,
        "bodies": bodies,
    });
    let out = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../src/harness-fixture.json");
    let bytes = serde_json::to_string(&fixture).expect("serialize fixture");
    let detail_count = fixture.get("details").map(|d| d.as_object().map_or(0, |m| m.len())).unwrap_or(0);
    let body_count = fixture.get("bodies").map(|b| b.as_object().map_or(0, |m| m.len())).unwrap_or(0);
    fs::write(&out, &bytes).expect("write harness-fixture.json");
    eprintln!("wrote {} ({} bytes, {} details, {} bodies)", out.display(), bytes.len(), detail_count, body_count);
}
