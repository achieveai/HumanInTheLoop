//! Persisted review drafts in `~/.hitl/drafts/`.
//!
//! A plan review is read and annotated over minutes, and closing the window
//! resolves nothing (D-7) — so the window can be closed, or the agent can exit,
//! with twenty typed comments still in it. Without this the reviewer loses all
//! of it silently.
//!
//! Keyed by `planId`, which S0 defines as the identity of the plan file's
//! location rather than of its contents, so a draft survives a revision.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::types::InlineComment;

/// The reviewer's in-progress work, exactly as `review.js` builds it.
///
/// Every field is `#[serde(default)]`: a draft written by an older client must
/// still load, because the alternative is discarding the very work this module
/// exists to protect.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewDraft {
    #[serde(default)]
    pub review_id: String,
    #[serde(default)]
    pub plan_id: String,
    /// The snapshot the comments were anchored against.
    #[serde(default)]
    pub snapshot_hash: String,
    #[serde(default)]
    pub overall_feedback: String,
    #[serde(default)]
    pub inline_comments: Vec<InlineComment>,
    /// Set here, not by the window — used only for diagnostics.
    #[serde(default)]
    pub saved_at: u64,
}

fn drafts_dir() -> Option<PathBuf> {
    crate::paths::hitl_dir().ok().map(|dir| dir.join("drafts"))
}

/// Which key a draft is filed under: `planId`, falling back to the review id.
///
/// A plan with no `planId` is still worth protecting, it just cannot survive a
/// revision — a per-review draft is strictly better than none.
fn draft_key(plan_id: &str, review_id: &str) -> Option<String> {
    match (plan_id.trim(), review_id.trim()) {
        ("", "") => None,
        ("", review) => Some(format!("review:{review}")),
        (plan, _) => Some(format!("plan:{plan}")),
    }
}

/// Hashed so the filename cannot be influenced by the key's contents.
///
/// `planId` arrives over the wire; joining it onto a path raw would make
/// `../../` a directory traversal. A hex digest has no such degrees of freedom.
fn draft_file(dir: &std::path::Path, key: &str) -> PathBuf {
    let digest = Sha256::digest(key.as_bytes());
    dir.join(format!("{digest:x}.json"))
}

/// Write the draft, replacing whatever was there. Last write wins, no merging.
pub fn save(draft: &ReviewDraft) -> Result<(), String> {
    let dir = drafts_dir().ok_or_else(|| "no home directory for the draft store".to_string())?;
    save_in(&dir, draft)
}

/// The directory `ensure_dir` has already created and locked down this run.
///
/// Creating it was costing a `create_dir_all` plus a `chmod` on every
/// keystroke — on a roaming or network-mapped home directory that is not free.
static ENSURED_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);

fn ensure_dir(dir: &Path) -> Result<(), String> {
    if ENSURED_DIR.lock().ok().and_then(|d| d.clone()).as_deref() == Some(dir) {
        return Ok(());
    }

    fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    restrict_dir(dir);

    if let Ok(mut ensured) = ENSURED_DIR.lock() {
        *ensured = Some(dir.to_path_buf());
    }
    Ok(())
}

fn forget_ensured_dir() {
    if let Ok(mut ensured) = ENSURED_DIR.lock() {
        *ensured = None;
    }
}

/// Temp-then-rename: a draft is saved on every keystroke, so a crash mid-write
/// is a real possibility and a truncated file would lose everything rather than
/// the last character. The temp name is unique because two review windows for
/// the same plan would otherwise race on it — a `Uuid::new_v4()` is in-memory
/// and costs nothing next to the write itself.
fn write_atomically(dir: &Path, path: &Path, json: &str) -> std::io::Result<()> {
    let temp = dir.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    fs::write(&temp, json.as_bytes())?;
    restrict_file(&temp);

    fs::rename(&temp, path).inspect_err(|_| {
        let _ = fs::remove_file(&temp);
    })
}

fn save_in(dir: &Path, draft: &ReviewDraft) -> Result<(), String> {
    let key = draft_key(&draft.plan_id, &draft.review_id)
        .ok_or_else(|| "draft has neither a planId nor a reviewId to file it under".to_string())?;
    let path = draft_file(dir, &key);
    let json = serde_json::to_string(draft).map_err(|e| format!("could not serialize draft: {e}"))?;

    ensure_dir(dir)?;

    match write_atomically(dir, &path, &json) {
        Ok(()) => Ok(()),
        // The directory was there when we last looked and is not now. Caching
        // that it exists must not turn a recoverable state into a review's
        // worth of lost typing, so re-create it and try once more.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            forget_ensured_dir();
            ensure_dir(dir)?;
            write_atomically(dir, &path, &json)
                .map_err(|e| format!("could not write {}: {e}", path.display()))
        }
        Err(e) => Err(format!("could not write {}: {e}", path.display())),
    }
}

/// Load the draft filed for this plan, if there is one.
pub fn load(plan_id: &str, review_id: &str) -> Option<ReviewDraft> {
    load_in(&drafts_dir()?, plan_id, review_id)
}

fn load_in(dir: &std::path::Path, plan_id: &str, review_id: &str) -> Option<ReviewDraft> {
    let path = draft_file(dir, &draft_key(plan_id, review_id)?);
    let raw = fs::read_to_string(&path).ok()?;

    match serde_json::from_str::<ReviewDraft>(&raw) {
        Ok(draft) => Some(draft),
        Err(e) => {
            // Do not delete it. A draft this build cannot parse may still be
            // readable by hand, and it is the human's writing, not ours.
            log::warn!("Ignoring unreadable draft at {}: {}", path.display(), e);
            None
        }
    }
}

/// Adapt a stored draft to the snapshot now on screen.
///
/// Inline comments are anchored to line numbers. `snapshotHash` is the hash of
/// the plan's contents, so a different hash means those lines are different
/// text — replaying the anchors would silently attach the reviewer's words to
/// the wrong code, which is worse than dropping them. The prose feedback is not
/// line-anchored and stays.
pub fn draft_for_snapshot(mut draft: ReviewDraft, snapshot_hash: &str) -> ReviewDraft {
    if draft.snapshot_hash != snapshot_hash && !draft.inline_comments.is_empty() {
        log::info!(
            "Draft for plan {} was written against a different revision; keeping the \
             feedback and dropping {} line-anchored comment(s)",
            draft.plan_id,
            draft.inline_comments.len()
        );
        draft.inline_comments.clear();
    }
    draft
}

/// Nothing to restore is `None`, not an empty draft the window would render as
/// a restored-but-blank state.
pub fn load_for_window(plan_id: &str, review_id: &str, snapshot_hash: &str) -> Option<ReviewDraft> {
    let draft = draft_for_snapshot(load(plan_id, review_id)?, snapshot_hash);
    if draft.overall_feedback.is_empty() && draft.inline_comments.is_empty() {
        return None;
    }
    Some(draft)
}

/// Delete the draft filed for this plan. Idempotent.
pub fn clear(plan_id: &str, review_id: &str) -> Result<(), String> {
    let dir = drafts_dir().ok_or_else(|| "no home directory for the draft store".to_string())?;
    clear_in(&dir, plan_id, review_id)
}

fn clear_in(dir: &std::path::Path, plan_id: &str, review_id: &str) -> Result<(), String> {
    let key = draft_key(plan_id, review_id)
        .ok_or_else(|| "no planId or reviewId to identify the draft to clear".to_string())?;
    let path = draft_file(dir, &key);

    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        // Already gone is the goal state. The window calls this after a submit
        // that may well have happened on another device, so "there was nothing
        // here" is the common case, not a fault.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("could not remove {}: {e}", path.display())),
    }
}

#[cfg(unix)]
fn restrict_dir(dir: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
}

#[cfg(unix)]
fn restrict_file(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}

// Windows inherits the ACL of ~/.hitl, which is already per-user.
#[cfg(not(unix))]
fn restrict_dir(_dir: &std::path::Path) {}
#[cfg(not(unix))]
fn restrict_file(_path: &std::path::Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn a_comment(line: u32) -> InlineComment {
        InlineComment {
            path: "docs/plan.md".to_string(),
            start_line: line,
            end_line: line,
            side: "new".to_string(),
            comment: "needs a test".to_string(),
        }
    }

    fn a_draft() -> ReviewDraft {
        ReviewDraft {
            review_id: "rev-1".to_string(),
            plan_id: "plan-abc".to_string(),
            snapshot_hash: "sha256:aa".to_string(),
            overall_feedback: "looks close".to_string(),
            inline_comments: vec![a_comment(12)],
            saved_at: 0,
        }
    }

    #[test]
    fn plan_id_keys_the_draft_so_it_survives_a_revision() {
        assert_eq!(draft_key("plan-abc", "rev-1").unwrap(), "plan:plan-abc");
        // Same plan, a later revision — same key, so the draft is found again.
        assert_eq!(draft_key("plan-abc", "rev-9").unwrap(), "plan:plan-abc");
    }

    #[test]
    fn a_plan_without_an_id_still_gets_a_per_review_draft() {
        assert_eq!(draft_key("", "rev-1").unwrap(), "review:rev-1");
        assert_eq!(draft_key("   ", "rev-1").unwrap(), "review:rev-1");
    }

    #[test]
    fn a_draft_with_nothing_to_key_on_is_refused_rather_than_written_somewhere() {
        assert!(draft_key("", "").is_none());
    }

    #[test]
    fn a_traversing_plan_id_cannot_escape_the_drafts_directory() {
        // planId arrives over the wire. Joined raw this would climb out of
        // ~/.hitl/drafts and overwrite an arbitrary file.
        let dir = std::path::Path::new("/home/u/.hitl/drafts");
        let path = draft_file(dir, "plan:../../../../etc/passwd");
        let name = path.file_name().unwrap().to_string_lossy().to_string();

        assert!(name.ends_with(".json"));
        assert!(
            name.trim_end_matches(".json").chars().all(|c| c.is_ascii_hexdigit()),
            "the filename must be a bare digest, got {name}"
        );
        assert_eq!(path.parent().unwrap(), dir);
    }

    #[test]
    fn distinct_keys_get_distinct_files() {
        let dir = std::path::Path::new("/drafts");
        assert_ne!(draft_file(dir, "plan:a"), draft_file(dir, "plan:b"));
        assert_eq!(draft_file(dir, "plan:a"), draft_file(dir, "plan:a"));
    }

    #[test]
    fn the_same_snapshot_restores_every_comment() {
        let restored = draft_for_snapshot(a_draft(), "sha256:aa");

        assert_eq!(restored.inline_comments.len(), 1);
        assert_eq!(restored.overall_feedback, "looks close");
    }

    #[test]
    fn a_revised_plan_keeps_the_prose_and_drops_the_stale_line_anchors() {
        // The lines moved, so anchor 12 no longer points at the text the
        // reviewer was talking about.
        let restored = draft_for_snapshot(a_draft(), "sha256:bb");

        assert!(restored.inline_comments.is_empty());
        assert_eq!(restored.overall_feedback, "looks close");
    }

    #[test]
    fn an_empty_draft_is_not_offered_to_the_window() {
        let empty = ReviewDraft {
            overall_feedback: String::new(),
            inline_comments: vec![],
            ..a_draft()
        };
        assert!(draft_for_snapshot(empty, "sha256:aa").inline_comments.is_empty());
    }

    #[test]
    fn a_draft_round_trips_through_the_json_the_window_sends() {
        // Exactly the object review.js's currentDraft() produces, camelCase and
        // with no savedAt — an unknown or missing field must not lose the work.
        let json = r#"{
            "reviewId": "rev-1",
            "planId": "plan-abc",
            "snapshotHash": "sha256:aa",
            "overallFeedback": "looks close",
            "inlineComments": [
                {"path":"docs/plan.md","startLine":12,"endLine":14,"side":"new","comment":"needs a test"}
            ]
        }"#;

        let draft: ReviewDraft = serde_json::from_str(json).unwrap();

        assert_eq!(draft.plan_id, "plan-abc");
        assert_eq!(draft.overall_feedback, "looks close");
        assert_eq!(draft.inline_comments.len(), 1);
        assert_eq!(draft.inline_comments[0].start_line, 12);
        assert_eq!(draft.inline_comments[0].end_line, 14);
        assert_eq!(draft.saved_at, 0);

        // And back out in the shape restoreDraft() reads.
        let out = serde_json::to_value(&draft).unwrap();
        assert_eq!(out["overallFeedback"], "looks close");
        assert_eq!(out["inlineComments"][0]["startLine"], 12);
    }

    #[test]
    fn a_partial_draft_still_loads() {
        // An older client, or a field this build has never heard of.
        let draft: ReviewDraft =
            serde_json::from_str(r#"{"planId":"p","overallFeedback":"x","extra":true}"#).unwrap();

        assert_eq!(draft.plan_id, "p");
        assert_eq!(draft.overall_feedback, "x");
        assert!(draft.inline_comments.is_empty());
    }

    /// A scratch directory, so no test writes into the real `~/.hitl/drafts`.
    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hitl-draft-{tag}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_draft_survives_the_window_closing_and_reopening() {
        // The whole point of the feature: twenty comments typed, window closed,
        // review reopened.
        let dir = temp_dir("roundtrip");

        save_in(&dir, &a_draft()).unwrap();
        let loaded = load_in(&dir, "plan-abc", "rev-1").unwrap();

        assert_eq!(loaded.overall_feedback, "looks close");
        assert_eq!(loaded.inline_comments.len(), 1);
        assert_eq!(loaded.inline_comments[0].start_line, 12);
        assert_eq!(loaded.inline_comments[0].comment, "needs a test");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_later_revision_of_the_same_plan_finds_the_same_draft() {
        let dir = temp_dir("revision");

        save_in(&dir, &a_draft()).unwrap();
        // Revision 2 is a different review message, so a different reviewId.
        let loaded = load_in(&dir, "plan-abc", "rev-2").unwrap();

        assert_eq!(loaded.overall_feedback, "looks close");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_last_write_wins_with_no_merging() {
        let dir = temp_dir("overwrite");

        save_in(&dir, &a_draft()).unwrap();
        let second = ReviewDraft {
            overall_feedback: "changed my mind".to_string(),
            inline_comments: vec![a_comment(3), a_comment(9)],
            ..a_draft()
        };
        save_in(&dir, &second).unwrap();

        let loaded = load_in(&dir, "plan-abc", "rev-1").unwrap();
        assert_eq!(loaded.overall_feedback, "changed my mind");
        assert_eq!(loaded.inline_comments.len(), 2);

        // And exactly one file, not one per save.
        let files: Vec<_> = fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).collect();
        assert_eq!(files.len(), 1, "temp files must not be left behind");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_plan_with_no_draft_yet_loads_nothing() {
        let dir = temp_dir("absent");

        assert!(load_in(&dir, "plan-never-saved", "rev-1").is_none());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_corrupt_draft_is_ignored_rather_than_crashing_the_window() {
        let dir = temp_dir("corrupt");
        let path = draft_file(&dir, &draft_key("plan-abc", "rev-1").unwrap());
        fs::write(&path, b"{ this is not json").unwrap();

        assert!(load_in(&dir, "plan-abc", "rev-1").is_none());
        // And it is kept, not deleted — it is the human's writing.
        assert!(path.exists());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn drafts_for_different_plans_do_not_collide() {
        let dir = temp_dir("distinct");

        save_in(&dir, &a_draft()).unwrap();
        save_in(
            &dir,
            &ReviewDraft {
                plan_id: "plan-other".to_string(),
                overall_feedback: "different plan".to_string(),
                ..a_draft()
            },
        )
        .unwrap();

        assert_eq!(load_in(&dir, "plan-abc", "").unwrap().overall_feedback, "looks close");
        assert_eq!(
            load_in(&dir, "plan-other", "").unwrap().overall_feedback,
            "different plan"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn clearing_a_delivered_review_removes_its_draft() {
        let dir = temp_dir("clear");

        save_in(&dir, &a_draft()).unwrap();
        assert!(load_in(&dir, "plan-abc", "rev-1").is_some());

        clear_in(&dir, "plan-abc", "rev-1").unwrap();

        assert!(load_in(&dir, "plan-abc", "rev-1").is_none());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn clearing_a_draft_that_was_never_saved_succeeds() {
        // The window clears after a submit that may have happened on another
        // device, so there is often nothing here. That is the goal state.
        let dir = temp_dir("clear-absent");

        assert!(clear_in(&dir, "plan-never-saved", "rev-1").is_ok());
        // And clearing twice is still fine.
        save_in(&dir, &a_draft()).unwrap();
        assert!(clear_in(&dir, "plan-abc", "rev-1").is_ok());
        assert!(clear_in(&dir, "plan-abc", "rev-1").is_ok());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn clearing_removes_only_the_targeted_draft() {
        let dir = temp_dir("clear-targeted");

        save_in(&dir, &a_draft()).unwrap();
        save_in(
            &dir,
            &ReviewDraft {
                plan_id: "plan-other".to_string(),
                overall_feedback: "still being written".to_string(),
                ..a_draft()
            },
        )
        .unwrap();

        clear_in(&dir, "plan-abc", "rev-1").unwrap();

        assert!(load_in(&dir, "plan-abc", "rev-1").is_none());
        assert_eq!(
            load_in(&dir, "plan-other", "").unwrap().overall_feedback,
            "still being written",
            "another plan's in-progress review must survive"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn clearing_uses_the_same_key_resolution_as_saving() {
        // A plan with no planId was saved under its reviewId, so it has to be
        // cleared under the reviewId too or it would linger forever.
        let dir = temp_dir("clear-fallback");
        let draft = ReviewDraft {
            plan_id: String::new(),
            review_id: "rev-1".to_string(),
            ..a_draft()
        };

        save_in(&dir, &draft).unwrap();
        assert!(load_in(&dir, "", "rev-1").is_some());

        clear_in(&dir, "", "rev-1").unwrap();

        assert!(load_in(&dir, "", "rev-1").is_none());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn clearing_with_nothing_to_key_on_is_an_error_rather_than_a_quiet_no_op() {
        let dir = temp_dir("clear-unkeyed");

        assert!(clear_in(&dir, "", "").is_err());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_vanished_drafts_directory_is_recreated_rather_than_losing_the_write() {
        // The directory is created once and remembered, so a later write does
        // not pay for create_dir_all + chmod. That cache must not turn a
        // recoverable state into a review's worth of lost typing.
        let dir = temp_dir("vanish");

        save_in(&dir, &a_draft()).unwrap();
        ensure_dir(&dir).unwrap();
        fs::remove_dir_all(&dir).unwrap();

        save_in(&dir, &a_draft()).unwrap();

        assert_eq!(
            load_in(&dir, "plan-abc", "rev-1").unwrap().overall_feedback,
            "looks close"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_keystrokes_worth_of_saves_leaves_exactly_one_file() {
        // The window saves per edit, so a leaked temp file per keystroke would
        // fill the directory over a long review.
        let dir = temp_dir("keystrokes");

        for i in 0..50 {
            save_in(
                &dir,
                &ReviewDraft {
                    overall_feedback: "x".repeat(i),
                    ..a_draft()
                },
            )
            .unwrap();
        }

        let files: Vec<_> = fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).collect();
        assert_eq!(files.len(), 1, "temp files must not accumulate");
        assert_eq!(
            load_in(&dir, "plan-abc", "rev-1").unwrap().overall_feedback.len(),
            49
        );

        let _ = fs::remove_dir_all(&dir);
    }
}
