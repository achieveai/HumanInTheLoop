//! Replying from the Inbox (spec §9).
//!
//! Every command here publishes through `hitl-transport`, on the same topic, in
//! the same shape, as the popup client and the phone. There is no Inbox reply
//! type, no Inbox reply channel and no arbiter: §9.1's whole argument is that
//! the shared total order already makes one unnecessary, and a private path
//! would be the one thing that could break it.
//!
//! What is different here — and it is the only thing — is that each command
//! hands back the `messageId` it minted. The publisher is the only participant
//! that knows which response is its own, and for a **question** there is no
//! `plan_review_ack` to be told later. So the id is returned, kept in the
//! webview, and compared against `MessageRow::response_id` on the next fold.
//! That comparison is the entire race decision (spec §9.3).

use hitl_transport::config::load_config;
use hitl_transport::drafts::ReviewDraft;
use hitl_transport::ntfy::publish::{publish_answer, publish_dismiss_notification};
use hitl_transport::ntfy::review::{
    submit_review_response, AckWaiters, OutstandingReviews, PlanReviewSubmitResult,
};
use hitl_transport::types::{
    AnswerMessage, DismissNotificationMessage, HitlConfig, InlineComment, PlanReviewResponseBody,
    SubAnswer,
};

/// Whether a reply this Inbox publishes should be encrypted.
///
/// The popup client mirrors whatever the request arrived as. The Inbox cannot:
/// `Store::append` is handed the *decrypted* payload and the log never records
/// which envelope it came out of — the same gap `Badges::plaintext` reports as
/// `None` rather than guessing.
///
/// So the config decides instead. A configured key means this topic is an
/// encrypted topic, and the MCP server tests each message for an envelope
/// individually (`ntfy-transport.ts`, `isEncryptedEnvelope`) using that same
/// key, so an encrypted reply to a plaintext request is read correctly. The
/// converse — replying in the clear on a topic the operator chose to encrypt —
/// is the one outcome worth avoiding, and this rule cannot produce it.
fn encrypt_replies(config: &HitlConfig) -> bool {
    config
        .encryption_key
        .as_deref()
        .is_some_and(|key| !key.trim().is_empty())
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Answer a question (spec §8.2). Returns the answer's own `messageId`.
///
/// `skipped` rides the same message rather than getting its own type, exactly
/// as the popup client sends it — a skip is an answer that declined.
#[tauri::command]
pub async fn submit_answer(
    question_id: String,
    selected_values: Vec<String>,
    other_text: Option<String>,
    skipped: bool,
    sub_answers: Option<Vec<SubAnswer>>,
) -> Result<String, String> {
    let config = load_config().map_err(|e| e.to_string())?;
    let response_id = uuid::Uuid::new_v4().to_string();

    let answer = AnswerMessage {
        msg_type: "answer".to_string(),
        message_id: response_id.clone(),
        question_id,
        timestamp: now_millis(),
        responded_from: config.device_name.clone(),
        selected_values,
        other_text,
        skipped,
        sub_answers,
    };

    publish_answer(&config, &answer, encrypt_replies(&config))
        .await
        .map_err(|e| e.to_string())?;

    Ok(response_id)
}

/// Dismiss a notification (spec §8.1). Returns the dismissal's `messageId`.
///
/// The row is not deleted anywhere. Every device folds this event into status
/// `dismissed` and keeps the message — which is the whole reason the Inbox can
/// answer "what did that agent tell me an hour ago" and the popup cannot.
#[tauri::command]
pub async fn dismiss_notification(notification_id: String) -> Result<String, String> {
    let config = load_config().map_err(|e| e.to_string())?;
    let response_id = uuid::Uuid::new_v4().to_string();

    let msg = DismissNotificationMessage {
        msg_type: "dismiss_notification".to_string(),
        message_id: response_id.clone(),
        timestamp: now_millis(),
        notification_id,
        dismissed_from: config.device_name.clone(),
    };

    publish_dismiss_notification(&config, &msg, encrypt_replies(&config))
        .await
        .map_err(|e| e.to_string())?;

    Ok(response_id)
}

/// Submit a plan-review verdict (spec §8.3).
///
/// Unlike the two above this does not return when the publish succeeds: a
/// response body large enough to spill to a ntfy attachment can expire before a
/// reconnecting agent reads it, so `submit_review_response` blocks for the
/// agent's acknowledgement and reports which of the three things happened.
/// `review.js` reads that status and keeps the draft for anything but
/// `received`.
///
/// The `changes_requested` / `rejected` feedback rule is **not** re-checked
/// here. `review.js::validateVerdict` refuses the submit before this command is
/// ever called, and the server's `normalizeResponseBody()` refuses it after — a
/// third copy of one rule is a third thing to keep in step.
#[tauri::command]
pub async fn submit_plan_review(
    waiters: tauri::State<'_, AckWaiters>,
    outstanding: tauri::State<'_, OutstandingReviews>,
    review_id: String,
    snapshot_hash: String,
    verdict: String,
    overall_feedback: String,
    inline_comments: Vec<InlineComment>,
) -> Result<PlanReviewSubmitResult, String> {
    let encrypted = encrypt_replies(&load_config().map_err(|e| e.to_string())?);

    submit_review_response(
        &waiters,
        &outstanding,
        review_id,
        snapshot_hash,
        verdict,
        PlanReviewResponseBody {
            overall_feedback,
            inline_comments,
        },
        encrypted,
    )
    .await
}

// ---------------------------------------------------------------------------
// Drafts — the same store, and the same promise, as the popup client's
// ---------------------------------------------------------------------------

/// Persist the review in progress. Fired on every edit, so it must stay cheap.
///
/// Same file, same key derivation, same directory as the popup client writes:
/// `hitl_transport::drafts` is shared, so a review begun in one and continued
/// in the other picks up where it left off.
#[tauri::command]
pub async fn save_review_draft(draft: ReviewDraft) -> Result<(), String> {
    let mut draft = draft;
    draft.saved_at = now_millis();

    run_blocking(move || hitl_transport::drafts::save(&draft))
        .await
        .inspect_err(|e| log::warn!("could not save the review draft: {e}"))
}

/// The draft to re-offer, or `None`.
///
/// The popup client has no command for this — its shell injects `_draft` into
/// the window payload before the window exists. The Inbox has one window and
/// selects into it, so it has to ask.
///
/// `snapshot_hash` is not decoration: `draft_for_snapshot` drops inline
/// comments whose anchors were written against different plan text, because
/// replaying a line anchor onto changed content attaches the reviewer's words
/// to the wrong lines.
#[tauri::command]
pub async fn load_review_draft(
    plan_id: Option<String>,
    review_id: Option<String>,
    snapshot_hash: Option<String>,
) -> Result<Option<ReviewDraft>, String> {
    let plan_id = plan_id.unwrap_or_default();
    let review_id = review_id.unwrap_or_default();
    let snapshot_hash = snapshot_hash.unwrap_or_default();

    tokio::task::spawn_blocking(move || {
        hitl_transport::drafts::load_for_window(&plan_id, &review_id, &snapshot_hash)
    })
    .await
    .map_err(|e| format!("the draft store task did not run: {e}"))
}

/// Delete a draft once its review has actually been delivered.
///
/// Called only for `status: "received"`. On `lost` or `unacknowledged` — and on
/// a lost race — the draft is the only surviving copy of the reviewer's work.
#[tauri::command]
pub async fn clear_review_draft(
    plan_id: Option<String>,
    review_id: Option<String>,
) -> Result<(), String> {
    let plan_id = plan_id.unwrap_or_default();
    let review_id = review_id.unwrap_or_default();

    run_blocking(move || hitl_transport::drafts::clear(&plan_id, &review_id))
        .await
        // Surfaced, not swallowed: a stale draft is a small annoyance, a draft
        // store that has silently stopped working is not.
        .inspect_err(|e| log::warn!("could not clear the review draft: {e}"))
}

/// Run a filesystem operation off the async workers.
///
/// `async fn` alone would not move it — it would relocate a synchronous `fs`
/// call onto an async worker and stall it there, once per keystroke, for as
/// long as the home directory takes to answer.
async fn run_blocking<F>(op: F) -> Result<(), String>
where
    F: FnOnce() -> Result<(), String> + Send + 'static,
{
    match tokio::task::spawn_blocking(op).await {
        Ok(result) => result,
        Err(e) => Err(format!("the draft store task did not run: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(key: Option<&str>) -> HitlConfig {
        HitlConfig {
            encryption_key: key.map(str::to_string),
            ..HitlConfig::default()
        }
    }

    #[test]
    fn a_configured_key_means_replies_are_encrypted() {
        assert!(encrypt_replies(&config(Some("00112233445566778899aabbccddeeff"))));
    }

    #[test]
    fn no_key_means_replies_go_out_in_the_clear() {
        // Not a fallback and not a downgrade: a topic with no key configured is
        // a plaintext topic, and encrypting into it would produce an envelope
        // nothing on the far end can open.
        assert!(!encrypt_replies(&config(None)));
    }

    #[test]
    fn a_blank_key_is_no_key() {
        // `""` and `"   "` are what an operator leaves behind after deleting a
        // key from `config.json`. Treated as configured, `crypto::encrypt`
        // would fail on every single reply.
        assert!(!encrypt_replies(&config(Some(""))));
        assert!(!encrypt_replies(&config(Some("   "))));
    }
}
