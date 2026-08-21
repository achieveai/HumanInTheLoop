//! Tauri commands for persisted review drafts.
//!
//! The draft store itself — filesystem layout, atomic writes, key derivation —
//! lives in `hitl_transport::drafts`, which a mobile build would need too. What
//! stays here is the window-facing surface: the two commands the review window
//! calls, and the blocking-pool hop those commands run on.

use hitl_transport::drafts::ReviewDraft;

/// Tauri command: persist the review window's draft.
///
/// Fired on every edit, so it must stay cheap and must never surface a dialog.
/// The window treats failure as best-effort; the log is where a broken draft
/// store becomes visible.
///
/// The write runs on the blocking pool. `async fn` alone would not move it —
/// it would only relocate a synchronous `fs` call onto an async worker and
/// stall it there, once per keystroke, for as long as the home directory takes
/// to answer. There is deliberately no debouncing: dropping the last keystrokes
/// before a close is the exact failure this feature exists to prevent.
#[tauri::command]
pub async fn save_review_draft(draft: ReviewDraft) -> Result<(), String> {
    let mut draft = draft;
    draft.saved_at = now_millis();

    match run_blocking(move || hitl_transport::drafts::save(&draft)).await {
        Ok(()) => Ok(()),
        Err(e) => {
            log::warn!("Could not save the review draft: {}", e);
            Err(e)
        }
    }
}

/// Tauri command: delete a draft once its review has actually been delivered.
///
/// Called only for `status: "received"`. On `lost` or `unacknowledged` the draft
/// is the sole surviving copy of the reviewer's work, so it must stay.
///
/// Both ids are optional so a caller that knows only one of them still clears
/// the right file; failing to parse the arguments would leave a draft behind
/// that gets re-offered against a review the human already finished.
#[tauri::command]
pub async fn clear_review_draft(
    plan_id: Option<String>,
    review_id: Option<String>,
) -> Result<(), String> {
    let plan_id = plan_id.unwrap_or_default();
    let review_id = review_id.unwrap_or_default();

    let (p, r) = (plan_id.clone(), review_id.clone());
    match run_blocking(move || hitl_transport::drafts::clear(&p, &r)).await {
        Ok(()) => {
            log::info!("Cleared the draft for plan {:?} / review {:?}", plan_id, review_id);
            Ok(())
        }
        Err(e) => {
            // Surfaced, not swallowed: a stale draft is a small annoyance, but
            // a store that has silently stopped working is not.
            log::warn!("Could not clear the review draft: {}", e);
            Err(e)
        }
    }
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Run a filesystem operation on the blocking pool.
async fn run_blocking<F>(op: F) -> Result<(), String>
where
    F: FnOnce() -> Result<(), String> + Send + 'static,
{
    match tauri::async_runtime::spawn_blocking(op).await {
        Ok(result) => result,
        Err(e) => Err(format!("the draft store task did not run: {e}")),
    }
}
