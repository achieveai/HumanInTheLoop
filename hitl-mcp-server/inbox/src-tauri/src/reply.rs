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

use std::collections::HashSet;
use std::future::Future;
use std::hash::Hash;
use std::sync::Arc;

use hitl_transport::config::load_config;
use hitl_transport::drafts::ReviewDraft;
use hitl_transport::ntfy::http::{http_client, REQUEST_TIMEOUT};
use hitl_transport::ntfy::publish::{
    publish_answer, publish_dismiss_notification, publish_dismiss_notification_with_client,
    publish_restore_notification_with_client,
};
use hitl_transport::ntfy::review::{
    submit_review_response, AckWaiters, OutstandingReviews, PlanReviewSubmitResult,
};
use hitl_transport::types::{
    AnswerMessage, DismissNotificationMessage, HitlConfig, InlineComment, PlanReviewResponseBody,
    RestoreNotificationMessage, SubAnswer,
};
use serde::{Deserialize, Serialize};

const MAX_IN_FLIGHT: usize = 8;

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

/// One immutable snapshot shared by every publish in a bulk invocation.
struct BulkPublishState {
    config: HitlConfig,
    encrypted: bool,
    client: reqwest::Client,
}

fn load_bulk_publish_state() -> Result<BulkPublishState, String> {
    let config = load_config().map_err(|e| e.to_string())?;
    Ok(BulkPublishState {
        encrypted: encrypt_replies(&config),
        config,
        client: http_client(Some(REQUEST_TIMEOUT), None),
    })
}

fn stable_deduplicate<T>(inputs: Vec<T>) -> Vec<T>
where
    T: Clone + Eq + Hash,
{
    let mut seen = HashSet::new();
    inputs
        .into_iter()
        .filter(|input| seen.insert(input.clone()))
        .collect()
}

fn spawn_publish<M, P, Fut>(
    tasks: &mut tokio::task::JoinSet<(usize, Result<(), String>)>,
    index: usize,
    message: M,
    state: Arc<BulkPublishState>,
    publish: Arc<P>,
) where
    M: Send + 'static,
    P: Fn(Arc<BulkPublishState>, M) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<(), String>> + Send + 'static,
{
    tasks.spawn(async move { (index, publish(state, message).await) });
}

/// Run a completion-ordered publish queue while returning input-ordered
/// outcomes. A task failure is local to its target; setup has already finished
/// before this function starts.
async fn publish_bounded<M, O, P, Fut, Finish>(
    messages: Vec<M>,
    state: BulkPublishState,
    publish: P,
    finish: Finish,
) -> Vec<O>
where
    M: Clone + Send + 'static,
    P: Fn(Arc<BulkPublishState>, M) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<(), String>> + Send + 'static,
    Finish: Fn(M, Result<(), String>) -> O,
{
    let state = Arc::new(state);
    let publish = Arc::new(publish);
    let mut tasks = tokio::task::JoinSet::new();
    let mut results: Vec<Option<Result<(), String>>> = (0..messages.len()).map(|_| None).collect();
    let mut task_errors = Vec::new();
    let mut next = 0;

    while next < messages.len() && tasks.len() < MAX_IN_FLIGHT {
        spawn_publish(
            &mut tasks,
            next,
            messages[next].clone(),
            state.clone(),
            publish.clone(),
        );
        next += 1;
    }

    while let Some(joined) = tasks.join_next().await {
        match joined {
            Ok((index, result)) => results[index] = Some(result),
            Err(error) => task_errors.push(format!("publish task failed: {error}")),
        }
        if next < messages.len() {
            spawn_publish(
                &mut tasks,
                next,
                messages[next].clone(),
                state.clone(),
                publish.clone(),
            );
            next += 1;
        }
    }

    let mut task_errors = task_errors.into_iter();
    messages
        .into_iter()
        .zip(results)
        .map(|(message, result)| {
            let result = result.unwrap_or_else(|| {
                Err(task_errors
                    .next()
                    .unwrap_or_else(|| "publish task did not return an outcome".to_string()))
            });
            finish(message, result)
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all_fields = "camelCase")]
pub enum DismissNotificationOutcome {
    #[serde(rename = "dismissed")]
    Dismissed {
        notification_id: String,
        response_id: String,
    },
    #[serde(rename = "failed")]
    Failed {
        notification_id: String,
        error: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreNotificationInput {
    pub notification_id: String,
    pub dismissal_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all_fields = "camelCase")]
pub enum RestoreNotificationOutcome {
    #[serde(rename = "restored")]
    Restored {
        notification_id: String,
        dismissal_id: String,
        response_id: String,
    },
    #[serde(rename = "failed")]
    Failed {
        notification_id: String,
        dismissal_id: String,
        error: String,
    },
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

async fn dismiss_notifications_with<Setup, Publish, Fut>(
    notification_ids: Vec<String>,
    setup: Setup,
    publish: Publish,
) -> Result<Vec<DismissNotificationOutcome>, String>
where
    Setup: FnOnce() -> Result<BulkPublishState, String>,
    Publish: Fn(Arc<BulkPublishState>, DismissNotificationMessage) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<(), String>> + Send + 'static,
{
    let notification_ids = stable_deduplicate(notification_ids);
    let state = setup()?;
    let device_name = state.config.device_name.clone();
    let messages = notification_ids
        .into_iter()
        .map(|notification_id| DismissNotificationMessage {
            msg_type: "dismiss_notification".to_string(),
            message_id: uuid::Uuid::new_v4().to_string(),
            timestamp: now_millis(),
            notification_id,
            dismissed_from: device_name.clone(),
        })
        .collect();

    Ok(
        publish_bounded(messages, state, publish, |message, result| match result {
            Ok(()) => DismissNotificationOutcome::Dismissed {
                notification_id: message.notification_id,
                response_id: message.message_id,
            },
            Err(error) => DismissNotificationOutcome::Failed {
                notification_id: message.notification_id,
                error,
            },
        })
        .await,
    )
}

/// Dismiss a stable set of notifications with one bounded native invocation.
#[tauri::command]
pub async fn dismiss_notifications(
    notification_ids: Vec<String>,
) -> Result<Vec<DismissNotificationOutcome>, String> {
    dismiss_notifications_with(
        notification_ids,
        load_bulk_publish_state,
        |state, message| async move {
            publish_dismiss_notification_with_client(
                &state.client,
                &state.config,
                &message,
                state.encrypted,
            )
            .await
            .map_err(|error| error.to_string())
        },
    )
    .await
}

async fn restore_notifications_with<Setup, Publish, Fut>(
    restorations: Vec<RestoreNotificationInput>,
    setup: Setup,
    publish: Publish,
) -> Result<Vec<RestoreNotificationOutcome>, String>
where
    Setup: FnOnce() -> Result<BulkPublishState, String>,
    Publish: Fn(Arc<BulkPublishState>, RestoreNotificationMessage) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<(), String>> + Send + 'static,
{
    let restorations = stable_deduplicate(restorations);
    let state = setup()?;
    let device_name = state.config.device_name.clone();
    let messages = restorations
        .into_iter()
        .map(|input| RestoreNotificationMessage {
            msg_type: "restore_notification".to_string(),
            message_id: uuid::Uuid::new_v4().to_string(),
            timestamp: now_millis(),
            notification_id: input.notification_id,
            dismissal_id: input.dismissal_id,
            restored_from: device_name.clone(),
        })
        .collect();

    Ok(
        publish_bounded(messages, state, publish, |message, result| match result {
            Ok(()) => RestoreNotificationOutcome::Restored {
                notification_id: message.notification_id,
                dismissal_id: message.dismissal_id,
                response_id: message.message_id,
            },
            Err(error) => RestoreNotificationOutcome::Failed {
                notification_id: message.notification_id,
                dismissal_id: message.dismissal_id,
                error,
            },
        })
        .await,
    )
}

/// Restore exact dismissal IDs with the same bounded native path as dismiss.
#[tauri::command]
pub async fn restore_notifications(
    restorations: Vec<RestoreNotificationInput>,
) -> Result<Vec<RestoreNotificationOutcome>, String> {
    restore_notifications_with(
        restorations,
        load_bulk_publish_state,
        |state, message| async move {
            publish_restore_notification_with_client(
                &state.client,
                &state.config,
                &message,
                state.encrypted,
            )
            .await
            .map_err(|error| error.to_string())
        },
    )
    .await
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
    // `Arc<AckWaiters>`, not `AckWaiters`: `main` shares this one value with
    // `InboxSink`, which is the only thing that ever sees the ack that
    // resolves a waiter registered here. Tauri resolves `State` by TypeId, so
    // the wrapper has to be named or the lookup misses at runtime.
    waiters: tauri::State<'_, Arc<AckWaiters>>,
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
    use std::collections::{HashMap, HashSet};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    use tokio::sync::{mpsc, Notify};

    fn config(key: Option<&str>) -> HitlConfig {
        HitlConfig {
            device_name: "test laptop".to_string(),
            encryption_key: key.map(str::to_string),
            ..HitlConfig::default()
        }
    }

    fn bulk_state() -> BulkPublishState {
        let config = config(None);
        BulkPublishState {
            encrypted: encrypt_replies(&config),
            config,
            client: reqwest::Client::new(),
        }
    }

    #[test]
    fn a_configured_key_means_replies_are_encrypted() {
        assert!(encrypt_replies(&config(Some(
            "00112233445566778899aabbccddeeff"
        ))));
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

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn bulk_dismiss_deduplicates_bounds_work_and_restores_input_order() {
        let expected: Vec<String> = (0..10).map(|index| format!("n-{index}")).collect();
        let mut inputs = expected.clone();
        inputs.insert(3, "n-2".to_string());

        let gates: Arc<HashMap<String, Arc<Notify>>> = Arc::new(
            expected
                .iter()
                .map(|id| (id.clone(), Arc::new(Notify::new())))
                .collect(),
        );
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let setup_calls = Arc::new(AtomicUsize::new(0));
        let state_addresses = Arc::new(Mutex::new(Vec::new()));
        let published = Arc::new(Mutex::new(Vec::new()));
        let (started_tx, mut started_rx) = mpsc::unbounded_channel();
        let (completed_tx, mut completed_rx) = mpsc::unbounded_channel();

        let task = tokio::spawn(dismiss_notifications_with(
            inputs,
            {
                let setup_calls = setup_calls.clone();
                move || {
                    setup_calls.fetch_add(1, Ordering::SeqCst);
                    Ok(bulk_state())
                }
            },
            {
                let gates = gates.clone();
                let active = active.clone();
                let peak = peak.clone();
                let state_addresses = state_addresses.clone();
                let published = published.clone();
                move |state, message| {
                    let gates = gates.clone();
                    let active = active.clone();
                    let peak = peak.clone();
                    let state_addresses = state_addresses.clone();
                    let published = published.clone();
                    let started_tx = started_tx.clone();
                    let completed_tx = completed_tx.clone();
                    async move {
                        let in_flight = active.fetch_add(1, Ordering::SeqCst) + 1;
                        peak.fetch_max(in_flight, Ordering::SeqCst);
                        state_addresses
                            .lock()
                            .unwrap()
                            .push(Arc::as_ptr(&state) as usize);
                        published.lock().unwrap().push(message.clone());
                        started_tx.send(message.notification_id.clone()).unwrap();
                        gates[&message.notification_id].notified().await;
                        active.fetch_sub(1, Ordering::SeqCst);
                        completed_tx.send(message.notification_id.clone()).unwrap();
                        if message.notification_id == "n-5" {
                            Err("offline n-5".to_string())
                        } else {
                            Ok(())
                        }
                    }
                }
            },
        ));

        let mut first_wave = Vec::new();
        for _ in 0..MAX_IN_FLIGHT {
            first_wave.push(started_rx.recv().await.unwrap());
        }
        first_wave.sort();
        assert_eq!(first_wave, expected[..MAX_IN_FLIGHT]);
        assert!(
            started_rx.try_recv().is_err(),
            "a ninth publish started before a slot opened"
        );

        let mut completion_order = Vec::new();
        for id in expected[..MAX_IN_FLIGHT].iter().rev() {
            gates[id].notify_one();
            completion_order.push(completed_rx.recv().await.unwrap());
        }
        let mut second_wave = vec![
            started_rx.recv().await.unwrap(),
            started_rx.recv().await.unwrap(),
        ];
        second_wave.sort();
        assert_eq!(second_wave, expected[MAX_IN_FLIGHT..]);
        for id in expected[MAX_IN_FLIGHT..].iter().rev() {
            gates[id].notify_one();
            completion_order.push(completed_rx.recv().await.unwrap());
        }

        let outcomes = task.await.unwrap().unwrap();
        assert_ne!(
            completion_order, expected,
            "the fixture must complete out of order"
        );
        assert_eq!(setup_calls.load(Ordering::SeqCst), 1);
        assert_eq!(peak.load(Ordering::SeqCst), MAX_IN_FLIGHT);
        assert_eq!(published.lock().unwrap().len(), expected.len());
        assert!(published
            .lock()
            .unwrap()
            .iter()
            .all(|message| message.dismissed_from == "test laptop"));
        assert_eq!(
            state_addresses
                .lock()
                .unwrap()
                .iter()
                .copied()
                .collect::<HashSet<_>>()
                .len(),
            1,
            "one invocation must reuse one config/client/encryption state"
        );

        assert_eq!(outcomes.len(), expected.len());
        for (index, outcome) in outcomes.iter().enumerate() {
            match (index, outcome) {
                (
                    5,
                    DismissNotificationOutcome::Failed {
                        notification_id,
                        error,
                    },
                ) => {
                    assert_eq!(notification_id, "n-5");
                    assert_eq!(error, "offline n-5");
                }
                (
                    _,
                    DismissNotificationOutcome::Dismissed {
                        notification_id,
                        response_id,
                    },
                ) => {
                    assert_eq!(notification_id, &expected[index]);
                    uuid::Uuid::parse_str(response_id).expect("native response UUID");
                }
                _ => panic!("unexpected outcome at {index}: {outcome:?}"),
            }
        }
        let encoded = serde_json::to_value(&outcomes).unwrap();
        assert_eq!(encoded[0]["notificationId"], "n-0");
        assert_eq!(encoded[0]["status"], "dismissed");
        assert!(encoded[0].get("responseId").is_some());
        assert_eq!(
            encoded[5],
            serde_json::json!({
                "notificationId": "n-5",
                "status": "failed",
                "error": "offline n-5"
            })
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn bulk_restore_deduplicates_bounds_work_and_restores_input_order() {
        let expected: Vec<RestoreNotificationInput> = (0..10)
            .map(|index| RestoreNotificationInput {
                notification_id: format!("n-{index}"),
                dismissal_id: format!("d-{index}"),
            })
            .collect();
        let mut inputs = expected.clone();
        inputs.insert(4, expected[2].clone());

        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let setup_calls = Arc::new(AtomicUsize::new(0));
        let state_addresses = Arc::new(Mutex::new(Vec::new()));
        let completion_order = Arc::new(Mutex::new(Vec::new()));

        let outcomes = restore_notifications_with(
            inputs,
            {
                let setup_calls = setup_calls.clone();
                move || {
                    setup_calls.fetch_add(1, Ordering::SeqCst);
                    Ok(bulk_state())
                }
            },
            {
                let active = active.clone();
                let peak = peak.clone();
                let state_addresses = state_addresses.clone();
                let completion_order = completion_order.clone();
                move |state, message| {
                    let active = active.clone();
                    let peak = peak.clone();
                    let state_addresses = state_addresses.clone();
                    let completion_order = completion_order.clone();
                    async move {
                        let index = message
                            .notification_id
                            .strip_prefix("n-")
                            .unwrap()
                            .parse::<u64>()
                            .unwrap();
                        let in_flight = active.fetch_add(1, Ordering::SeqCst) + 1;
                        peak.fetch_max(in_flight, Ordering::SeqCst);
                        state_addresses
                            .lock()
                            .unwrap()
                            .push(Arc::as_ptr(&state) as usize);
                        tokio::time::sleep(std::time::Duration::from_millis(20 - index)).await;
                        active.fetch_sub(1, Ordering::SeqCst);
                        completion_order
                            .lock()
                            .unwrap()
                            .push(message.notification_id.clone());
                        assert_eq!(message.restored_from, "test laptop");
                        if message.notification_id == "n-4" {
                            Err("restore rejected".to_string())
                        } else {
                            Ok(())
                        }
                    }
                }
            },
        )
        .await
        .unwrap();

        assert_eq!(setup_calls.load(Ordering::SeqCst), 1);
        assert_eq!(peak.load(Ordering::SeqCst), MAX_IN_FLIGHT);
        assert_ne!(
            *completion_order.lock().unwrap(),
            expected
                .iter()
                .map(|input| input.notification_id.clone())
                .collect::<Vec<_>>()
        );
        assert_eq!(
            state_addresses
                .lock()
                .unwrap()
                .iter()
                .copied()
                .collect::<HashSet<_>>()
                .len(),
            1
        );
        assert_eq!(outcomes.len(), expected.len());
        for (index, outcome) in outcomes.iter().enumerate() {
            match (index, outcome) {
                (
                    4,
                    RestoreNotificationOutcome::Failed {
                        notification_id,
                        dismissal_id,
                        error,
                    },
                ) => {
                    assert_eq!(notification_id, "n-4");
                    assert_eq!(dismissal_id, "d-4");
                    assert_eq!(error, "restore rejected");
                }
                (
                    _,
                    RestoreNotificationOutcome::Restored {
                        notification_id,
                        dismissal_id,
                        response_id,
                    },
                ) => {
                    assert_eq!(notification_id, &expected[index].notification_id);
                    assert_eq!(dismissal_id, &expected[index].dismissal_id);
                    uuid::Uuid::parse_str(response_id).expect("native response UUID");
                }
                _ => panic!("unexpected outcome at {index}: {outcome:?}"),
            }
        }
        let encoded = serde_json::to_value(&outcomes).unwrap();
        assert_eq!(encoded[0]["notificationId"], "n-0");
        assert_eq!(encoded[0]["dismissalId"], "d-0");
        assert_eq!(encoded[0]["status"], "restored");
        assert!(encoded[0].get("responseId").is_some());
        assert_eq!(
            encoded[4],
            serde_json::json!({
                "notificationId": "n-4",
                "dismissalId": "d-4",
                "status": "failed",
                "error": "restore rejected"
            })
        );

        let parsed: RestoreNotificationInput = serde_json::from_value(serde_json::json!({
            "notificationId": "n-camel",
            "dismissalId": "d-camel"
        }))
        .unwrap();
        assert_eq!(parsed.notification_id, "n-camel");
        assert_eq!(parsed.dismissal_id, "d-camel");
    }

    #[tokio::test]
    async fn bulk_setup_errors_reject_before_any_publish_starts() {
        let dismiss_publishes = Arc::new(AtomicUsize::new(0));
        let dismiss_error = dismiss_notifications_with(
            vec!["n-1".to_string()],
            || Err("config unavailable".to_string()),
            {
                let dismiss_publishes = dismiss_publishes.clone();
                move |_, _| {
                    dismiss_publishes.fetch_add(1, Ordering::SeqCst);
                    async { Ok(()) }
                }
            },
        )
        .await
        .unwrap_err();
        assert_eq!(dismiss_error, "config unavailable");
        assert_eq!(dismiss_publishes.load(Ordering::SeqCst), 0);

        let restore_publishes = Arc::new(AtomicUsize::new(0));
        let restore_error = restore_notifications_with(
            vec![RestoreNotificationInput {
                notification_id: "n-1".to_string(),
                dismissal_id: "d-1".to_string(),
            }],
            || Err("snapshot unavailable".to_string()),
            {
                let restore_publishes = restore_publishes.clone();
                move |_, _| {
                    restore_publishes.fetch_add(1, Ordering::SeqCst);
                    async { Ok(()) }
                }
            },
        )
        .await
        .unwrap_err();
        assert_eq!(restore_error, "snapshot unavailable");
        assert_eq!(restore_publishes.load(Ordering::SeqCst), 0);
    }
}
