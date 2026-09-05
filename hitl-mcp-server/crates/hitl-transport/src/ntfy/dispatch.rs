use std::collections::HashSet;

use crate::chunking::ChunkAssembler;
use crate::crypto;
use crate::ntfy::subscribe::{parse_ntfy_event, NtfyEvent, SeenIds};
use crate::ntfy::NtfySink;
use crate::payload::PayloadError;
use crate::types::{
    AnswerMessage, AttachmentRef, CancelReviewMessage, ChunkMessage, DismissNotificationMessage,
    HitlConfig, MessageEnvelope, NotificationMessage, PlanReviewAckMessage, PlanReviewMessage,
    PlanReviewResponseMessage, QuestionMessage, RestoreNotificationMessage, SenderIdentityMessage,
    SUPPORTED_PROTOCOL_VERSION,
};

/// Try to decrypt a raw message string.
/// Returns Some((json_string, was_encrypted)) on success, or None if the message
/// should be skipped (encrypted but no key, or decryption failed).
pub fn try_decrypt(raw: &str, config: &HitlConfig) -> Option<(String, bool)> {
    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(raw) {
        if crypto::is_encrypted(&parsed) {
            if let Some(ref key) = config.encryption_key {
                match crypto::decrypt_value(&parsed, key) {
                    Ok(decrypted) => return Some((decrypted, true)),
                    Err(e) => {
                        log::warn!("Failed to decrypt message: {}", e);
                        return None;
                    }
                }
            } else {
                log::warn!("Received encrypted message but no encryptionKey configured — skipping");
                return None;
            }
        }
    }
    Some((raw.to_string(), false))
}

/// If `decrypted` is a chunk fragment, feed it to the assembler and only return
/// Some(..) once its group is fully reassembled — re-running decryption on the
/// recovered body, since it may itself be an encrypted envelope. Non-chunk
/// messages pass through unchanged.
pub fn resolve_chunked_message(
    decrypted: &str,
    was_encrypted: bool,
    config: &HitlConfig,
    assembler: &mut ChunkAssembler,
) -> Option<(String, bool)> {
    if let Ok(chunk) = serde_json::from_str::<ChunkMessage>(decrypted) {
        if chunk.msg_type == "chunk" {
            let reassembled = assembler.feed(chunk)?;
            return try_decrypt(&reassembled, config);
        }
    }
    Some((decrypted.to_string(), was_encrypted))
}

/// Clip a string to `max_chars` characters without splitting one.
///
/// `String::truncate` counts bytes and panics if the cut lands inside a
/// character. The strings clipped here are relay-supplied error bodies — a
/// localized proxy error page is exactly the input that carries a multi-byte
/// character, and the panic would land inside `submit_plan_review`, leaving the
/// review window stuck on "submitting…" with the human's comments unrecoverable.
pub fn clip_chars(s: &str, max_chars: usize) -> String {
    s.chars().take(max_chars).collect()
}

/// Extract the IDs of questions and reviews the cache shows are already settled.
///
/// Answers settle questions; a response or a cancellation settles a review.
/// Without the latter two, every client start would re-open a review window for
/// a plan that was reviewed hours ago — and, past the 3 h attachment expiry,
/// re-open it as "plan expired".
pub fn extract_answered_ids(body: &str, config: &HitlConfig) -> HashSet<String> {
    let mut answered = HashSet::new();
    for line in body.lines() {
        let line = line.trim();
        if line.is_empty() { continue; }

        let Some(event) = parse_ntfy_event(line) else { continue };
        let Some((decrypted, _)) = try_decrypt(&event.message, config) else { continue };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&decrypted) else { continue };

        // Read the settling id straight off the parsed value rather than via
        // the concrete type. A message whose full shape this build cannot parse
        // still settles its target — and not recording it would re-open that
        // window on every single client start, forever.
        let settles = match value.get("type").and_then(|t| t.as_str()) {
            Some("answer") => value.get("questionId"),
            Some("plan_review_response") | Some("cancel_review") => value.get("reviewId"),
            _ => None,
        };

        if let Some(id) = settles.and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
            answered.insert(id.to_string());
        }
    }
    answered
}

/// Decrypt every cached line and reassemble any chunked messages, in order.
///
/// The ntfy envelope travels alongside the decrypted body rather than being
/// reduced to its attachment: `id` and `time` exist only on the envelope and
/// cannot be recovered from our own payload, and they are the total-order key
/// (spec §4.3). A recorder that lost them here would have to invent an ordering
/// of its own for exactly the messages a restart replays. A chunked group is
/// reported under the envelope of its **final** chunk — the one whose arrival
/// completed the message — so the same group always resolves to the same id.
pub fn decrypt_and_reassemble_cache(
    body: &str,
    config: &HitlConfig,
) -> Vec<(NtfyEvent, String, bool)> {
    let mut assembler = ChunkAssembler::new();
    let mut messages = Vec::new();

    for line in body.lines() {
        let line = line.trim();
        if line.is_empty() { continue; }

        if let Some(event) = parse_ntfy_event(line) {
            if let Some((decrypted, was_encrypted)) = try_decrypt(&event.message, config) {
                if let Some((resolved, resolved_encrypted)) =
                    resolve_chunked_message(&decrypted, was_encrypted, config, &mut assembler)
                {
                    messages.push((event, resolved, resolved_encrypted));
                }
            }
        }
    }

    messages
}

/// Where a message came from.
///
/// Cached messages are replayed on every startup, so they must not resurrect
/// ephemeral UI or re-show a question that has already been answered. Dispatch
/// consults this instead of keeping a second, subtly-different type chain —
/// the live and cache chains used to disagree about which types they handled.
pub enum Origin<'a> {
    /// `seen` suppresses the redelivery a reconnect necessarily produces:
    /// `since=` is inclusive, so the boundary event arrives again every time.
    Live { seen: &'a mut SeenIds },
    Cache {
        answered_ids: &'a HashSet<String>,
        seen: &'a mut SeenIds,
    },
}

impl Origin<'_> {
    /// The de-dup set, whichever origin this is.
    ///
    /// Both arms carry the same set. De-dup that depended on which origin a
    /// message arrived from left the cache path with none at all — and the
    /// cache can hold the same messageId twice, because a publish whose
    /// response was lost gets retried against an ntfy that already stored it.
    pub fn seen(&mut self) -> &mut SeenIds {
        match self {
            Origin::Live { seen } => seen,
            Origin::Cache { seen, .. } => seen,
        }
    }
}

/// Why a plan body could not be produced for the review window.
///
/// Every variant has to reach the human as words. A review that renders as a
/// blank window is indistinguishable from a client that is simply broken, and
/// the agent is blocked on the other end either way.
#[derive(Debug)]
pub enum ReviewBodyError {
    /// The attachment URL could not be fetched at all.
    Network(String),
    /// The reference said `attachment` but the ntfy event carried no metadata,
    /// so there is nothing to fetch.
    NoAttachment,
    Payload(PayloadError),
}

impl ReviewBodyError {
    /// Stable discriminant for the window's error panel. The strings are a
    /// contract with `review.js`, not a log format.
    pub fn kind(&self) -> &'static str {
        match self {
            ReviewBodyError::Network(_) => "unavailable",
            ReviewBodyError::NoAttachment => "missing",
            ReviewBodyError::Payload(PayloadError::Expired) => "expired",
            ReviewBodyError::Payload(PayloadError::HashMismatch { .. }) => "hash_mismatch",
            ReviewBodyError::Payload(PayloadError::Decrypt(_)) => "decrypt",
            ReviewBodyError::Payload(PayloadError::MissingData) => "missing",
            ReviewBodyError::Payload(
                PayloadError::Base64(_)
                | PayloadError::Gunzip(_)
                | PayloadError::Json(_)
                | PayloadError::TooLarge { .. }
                // Encode-side only; `decode_payload` never produces this, but
                // the match must stay exhaustive over `PayloadError`.
                | PayloadError::TooLargeToSubmit,
            ) => "corrupt",
        }
    }
}

impl std::fmt::Display for ReviewBodyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ReviewBodyError::Network(e) => write!(f, "could not fetch the plan attachment: {e}"),
            ReviewBodyError::NoAttachment => write!(
                f,
                "the plan says its body is an attachment but the message carried no attachment"
            ),
            ReviewBodyError::Payload(e) => write!(f, "{e}"),
        }
    }
}

/// What the protocol-version gate decides to do with a message.
#[derive(Debug, PartialEq, Eq)]
pub enum VersionVerdict {
    /// This build understands the wire shape; dispatch normally.
    Handle,
    /// Too new, and a human is waiting on it — say so on screen.
    ShowUpgradePanel,
    /// Too new, but nothing human-facing is blocked on it.
    Ignore,
}

/// Decide what a message's `protocolVersion` means for this build.
///
/// A-7: silently ignoring a message this client cannot read is the exact
/// failure the version field was added to prevent — a bumped release would
/// leave every agent blocked forever on a request the human never sees.
///
/// The default for a too-new message is therefore to show the panel, including
/// for message types this build has never heard of, since a future
/// human-facing type would otherwise vanish. Only the settlement types are
/// exempt: they resolve something rather than ask for it, so nothing waits on
/// them, and one panel per ack during a version mismatch would bury the one
/// panel that matters.
pub fn version_verdict(version: u32, msg_type: &str) -> VersionVerdict {
    if version <= SUPPORTED_PROTOCOL_VERSION {
        return VersionVerdict::Handle;
    }

    match msg_type {
        "answer" | "plan_review_response" | "plan_review_ack" | "cancel_review"
        | "dismiss_notification" | "restore_notification" | "chunk" => VersionVerdict::Ignore,
        _ => VersionVerdict::ShowUpgradePanel,
    }
}

/// Route one decrypted, fully-reassembled message to its handler.
///
/// Envelope-first: the concrete type is chosen by `type`, not guessed by trying
/// four `serde_json::from_str` calls in sequence. The old chain had no terminal
/// branch, so any message it could not parse vanished — no window, no log — and
/// a blocked agent would wait forever for an answer that could never arrive.
///
/// Every side effect leaves through `sink`. That is what makes this function
/// testable at all: it used to take an `&AppHandle` and reach into a dozen
/// windows, and consequently had no coverage whatsoever.
pub async fn dispatch_message(
    sink: &impl NtfySink,
    config: &HitlConfig,
    raw: &str,
    was_encrypted: bool,
    attachment: Option<AttachmentRef>,
    mut origin: Origin<'_>,
) {
    let env = match serde_json::from_str::<MessageEnvelope>(raw) {
        Ok(env) => env,
        Err(e) => {
            log::warn!("Undecodable message envelope: {}", e);
            return;
        }
    };

    if !origin.seen().insert(&env.message_id) {
        log::debug!(
            "Skipping {} {} — already dispatched this run",
            env.msg_type,
            env.message_id
        );
        return;
    }

    match version_verdict(env.version(), &env.msg_type) {
        VersionVerdict::Handle => {}
        VersionVerdict::ShowUpgradePanel => {
            log::warn!(
                "Message {} ({}) declares protocolVersion {} but this client supports {} — \
                 showing the upgrade panel",
                env.message_id,
                env.msg_type,
                env.version(),
                SUPPORTED_PROTOCOL_VERSION
            );
            sink.on_unsupported_version(&env.message_id, &env.msg_type, env.version(), raw);
            return;
        }
        VersionVerdict::Ignore => {
            log::warn!(
                "Message {} ({}) declares protocolVersion {} but this client supports {} — \
                 ignoring, nothing is waiting on it",
                env.message_id,
                env.msg_type,
                env.version(),
                SUPPORTED_PROTOCOL_VERSION
            );
            return;
        }
    }

    match env.msg_type.as_str() {
        "question" => match serde_json::from_str::<QuestionMessage>(raw) {
            Ok(question) => {
                if let Origin::Cache { answered_ids, .. } = origin {
                    if answered_ids.contains(&question.message_id) {
                        return;
                    }
                    log::info!("Showing pending question from cache: {}", question.message_id);
                } else {
                    log::info!("Received question: {}", question.message_id);
                }
                sink.on_question(&question, was_encrypted);
            }
            Err(e) => log::error!("question {} parse failed: {}", env.message_id, e),
        },

        "answer" => {
            // Cached answers are exactly what extract_answered_ids already
            // consumed; replaying them would emit dismissals for windows that
            // were never opened.
            if matches!(origin, Origin::Cache { .. }) {
                return;
            }
            match serde_json::from_str::<AnswerMessage>(raw) {
                Ok(answer) => {
                    log::info!(
                        "Received answer for question {}: from {}",
                        answer.question_id, answer.responded_from
                    );
                    sink.on_answer(&answer);
                }
                Err(e) => log::error!("answer {} parse failed: {}", env.message_id, e),
            }
        }

        "notification" => {
            // Cached notifications are intentionally skipped — they're ephemeral.
            if matches!(origin, Origin::Cache { .. }) {
                return;
            }
            match serde_json::from_str::<NotificationMessage>(raw) {
                Ok(notification) => sink.on_notification(&notification, was_encrypted),
                Err(e) => log::error!("notification {} parse failed: {}", env.message_id, e),
            }
        }

        "dismiss_notification" => {
            if matches!(origin, Origin::Cache { .. }) {
                return;
            }
            match serde_json::from_str::<DismissNotificationMessage>(raw) {
                Ok(dismiss) => {
                    log::info!(
                        "Received dismiss for notification {}: from {}",
                        dismiss.notification_id, dismiss.dismissed_from
                    );
                    sink.on_dismiss_notification(&dismiss);
                }
                Err(e) => log::error!("dismiss_notification {} parse failed: {}", env.message_id, e),
            }
        }

        "restore_notification" => {
            if matches!(origin, Origin::Cache { .. }) {
                return;
            }
            match serde_json::from_str::<RestoreNotificationMessage>(raw) {
                Ok(restore) => {
                    log::info!(
                        "Received restore for notification {} dismissal {}: from {}",
                        restore.notification_id, restore.dismissal_id, restore.restored_from
                    );
                    sink.on_restore_notification(&restore);
                }
                Err(e) => log::error!("restore_notification {} parse failed: {}", env.message_id, e),
            }
        }

        // The agent has (or has not) actually read a response we published.
        // Handing it to the waiting submit call is the whole point of C-12.
        "plan_review_ack" => {
            if matches!(origin, Origin::Cache { .. }) {
                return;
            }
            match serde_json::from_str::<PlanReviewAckMessage>(raw) {
                Ok(ack) => sink.on_plan_review_ack(&ack),
                Err(e) => log::error!("plan_review_ack {} parse failed: {}", env.message_id, e),
            }
        }

        "plan_review" => match serde_json::from_str::<PlanReviewMessage>(raw) {
            Ok(review) => {
                if let Origin::Cache { answered_ids, .. } = origin {
                    if answered_ids.contains(&review.message_id) {
                        return;
                    }
                    log::info!("Showing pending review from cache: {}", review.message_id);
                } else {
                    log::info!(
                        "Received plan_review {} (revision {}, {})",
                        review.message_id,
                        review.revision,
                        review.display_path
                    );
                }
                // The sink is responsible for getting this off the dispatch
                // path. It is the one handler that makes a network call — the
                // attachment download — and dispatch is awaited inline inside
                // the stream loop, so doing that work here would let one slow
                // or hung host stop every later message from being dispatched.
                sink.on_plan_review(&review, was_encrypted, attachment);
            }
            Err(e) => log::error!("plan_review {} parse failed: {}", env.message_id, e),
        },

        // Somebody finished this review — possibly on another device.
        //
        // Emit, never close. A review window holds however many minutes of
        // typed comments the human has invested; closing it here would discard
        // all of them. The window decides for itself what to show.
        "plan_review_response" => {
            if matches!(origin, Origin::Cache { .. }) {
                return;
            }
            match serde_json::from_str::<PlanReviewResponseMessage>(raw) {
                Ok(response) => {
                    // Our own submission comes back over the same stream. The
                    // window that sent it is already showing its own outcome.
                    if response.responded_from == config.device_name {
                        return;
                    }
                    log::info!(
                        "Review {} was answered on {} ({})",
                        response.review_id,
                        response.responded_from,
                        response.verdict
                    );
                    sink.on_plan_review_response(&response);
                }
                Err(e) => log::error!(
                    "plan_review_response {} parse failed: {}",
                    env.message_id,
                    e
                ),
            }
        }

        // The agent will never read this review. Tell the window so it can say
        // so and keep the typed comments as a draft rather than lose them.
        "cancel_review" => {
            if matches!(origin, Origin::Cache { .. }) {
                return;
            }
            match serde_json::from_str::<CancelReviewMessage>(raw) {
                Ok(cancel) => {
                    log::info!(
                        "Review {} cancelled by the agent: {}",
                        cancel.review_id,
                        cancel.reason
                    );
                    sink.on_cancel_review(&cancel);
                }
                Err(e) => log::error!("cancel_review {} parse failed: {}", env.message_id, e),
            }
        }

        // Decoration for a question/notification, published separately so the
        // four legacy wire shapes never gain a field. No `Origin::Cache` gate,
        // unlike the settlement arms above: this is not a settling event, and
        // a client starting up with pending cached questions still needs their
        // badges — the same message is handled identically from either origin.
        // Never blocks, retries, or surfaces a user-visible error: a parse
        // failure or an unmatched target is dropped silently.
        "sender_identity" => match serde_json::from_str::<SenderIdentityMessage>(raw) {
            Ok(msg) => sink.on_sender_identity(&msg),
            Err(e) => log::error!("sender_identity parse failed: {}", e),
        },

        // Only reachable when `resolve_chunked_message` could NOT parse the
        // fragment as a `ChunkMessage` — a parsed one is either held for its
        // group or dispatched as the reassembled body, and never arrives here
        // still typed "chunk". So this arm means a fragment was dropped, and
        // its whole group will now expire incomplete.
        "chunk" => log::warn!(
            "Chunk fragment {} could not be parsed as a fragment and was dropped; \
             its group will never complete",
            env.message_id
        ),

        other => log::warn!(
            "Unrecognized message type '{}' (id {})",
            other, env.message_id
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn envelope(version: u32, msg_type: &str) -> VersionVerdict {
        version_verdict(version, msg_type)
    }

    // --- Cache settlement (W2.8 / D-6) ---

    fn cache_line(message: &str) -> String {
        format!(
            r#"{{"id":"e","time":1,"event":"message","topic":"t","message":{}}}"#,
            serde_json::to_string(message).unwrap()
        )
    }

    #[test]
    fn the_cache_path_hands_back_ntfys_envelope_with_each_message() {
        // ntfy's id and time exist only on the envelope. A recorder replaying
        // the cache on every start has to dedup on that id — anything it
        // derived from the payload would differ between the cache copy and the
        // live copy of the same event, and the message would be stored twice.
        let body = [
            format!(
                r#"{{"id":"ntfy-a","time":1786504000,"event":"message","topic":"t","message":{}}}"#,
                serde_json::to_string(r#"{"type":"question","messageId":"q-1"}"#).unwrap()
            ),
            format!(
                concat!(
                    r#"{{"id":"ntfy-b","time":1786504100,"event":"message","topic":"t","#,
                    r#""message":{},"#,
                    r#""attachment":{{"name":"p.bin","url":"https://n/file/p.bin"}}}}"#
                ),
                serde_json::to_string(r#"{"type":"plan_review","messageId":"p-1"}"#).unwrap()
            ),
        ]
        .join("\n");

        let got = decrypt_and_reassemble_cache(&body, &HitlConfig::default());

        assert_eq!(got.len(), 2);
        assert_eq!(got[0].0.id, "ntfy-a");
        assert_eq!(got[0].0.time, 1_786_504_000);
        assert!(got[0].1.contains("q-1"));
        assert_eq!(got[1].0.id, "ntfy-b");
        assert_eq!(
            got[1].0.attachment.as_ref().map(|a| a.url.as_str()),
            Some("https://n/file/p.bin"),
            "the attachment must still ride along with its own event"
        );
    }

    #[test]
    fn answered_ids_covers_answers_responses_and_cancellations() {
        // A review settled hours ago must not re-open on the next client start —
        // past the 3 h attachment expiry it would re-open as "plan expired".
        let body = [
            cache_line(r#"{"type":"answer","questionId":"q-1"}"#),
            cache_line(r#"{"type":"plan_review_response","reviewId":"r-1"}"#),
            cache_line(r#"{"type":"cancel_review","reviewId":"r-2"}"#),
            cache_line(r#"{"type":"question","messageId":"q-2"}"#),
            cache_line(r#"{"type":"plan_review","messageId":"r-3"}"#),
        ]
        .join("\n");

        let settled = extract_answered_ids(&body, &HitlConfig::default());

        assert!(settled.contains("q-1"));
        assert!(settled.contains("r-1"));
        assert!(settled.contains("r-2"));
        assert!(!settled.contains("q-2"), "an unanswered question is not settled");
        assert!(!settled.contains("r-3"), "an unreviewed plan is not settled");
    }

    #[test]
    fn answered_ids_survives_junk_lines_in_the_cache_body() {
        let body = format!(
            "\n  \nnot json\n{}\n{}\n",
            cache_line("also not json"),
            cache_line(r#"{"type":"answer","questionId":"q-1"}"#)
        );

        assert!(extract_answered_ids(&body, &HitlConfig::default()).contains("q-1"));
    }

    #[test]
    fn clipping_an_error_body_never_splits_a_character() {
        // The sibling of the window_label byte-slice panic. A localized proxy
        // error page with a multi-byte character straddling the cut used to
        // panic inside submit_plan_review, stranding the review window on
        // "submitting…" with the typed comments lost.
        let multibyte = "é".repeat(300);
        assert_eq!(clip_chars(&multibyte, 200).chars().count(), 200);

        // A cut landing mid-character in byte space is the case that panicked.
        let straddling = format!("{}日本語", "a".repeat(199));
        assert_eq!(clip_chars(&straddling, 200), format!("{}日", "a".repeat(199)));

        // Shorter than the limit, and empty, both pass through untouched.
        assert_eq!(clip_chars("short", 200), "short");
        assert_eq!(clip_chars("", 200), "");
        assert_eq!(clip_chars("日本語", 0), "");
    }

    #[test]
    fn a_duplicate_message_is_dispatched_once_whichever_origin_it_arrives_from() {
        // The shipping AskUserQuestion break. De-dup used to apply only to the
        // live stream, so two identical events in the ntfy cache produced two
        // synchronous show_question calls microseconds apart. The second one's
        // failed window build tore the payload back out of the store while the
        // first window's webview was still loading — leaving a dead dialog on
        // a question nothing could then answer.
        let mut seen = SeenIds::with_capacity(8);
        let answered = HashSet::new();

        {
            let mut cache = Origin::Cache {
                answered_ids: &answered,
                seen: &mut seen,
            };
            assert!(cache.seen().insert("q-1"), "first sighting dispatches");
            assert!(
                !cache.seen().insert("q-1"),
                "a duplicate inside the cache must not dispatch twice"
            );
        }

        // Same set carries into the live phase: the cache replay and the
        // subscription overlap by design, so the handover must not re-dispatch.
        let mut live = Origin::Live { seen: &mut seen };
        assert!(
            !live.seen().insert("q-1"),
            "the cache/live overlap must not re-dispatch"
        );
        assert!(live.seen().insert("q-2"), "an unrelated message still dispatches");
    }

    #[test]
    fn a_supported_version_is_dispatched_normally() {
        for msg_type in ["question", "plan_review", "answer", "chunk"] {
            assert_eq!(envelope(SUPPORTED_PROTOCOL_VERSION, msg_type), VersionVerdict::Handle);
            assert_eq!(envelope(1, msg_type), VersionVerdict::Handle);
        }
    }

    #[test]
    fn a_too_new_message_a_human_is_waiting_on_reaches_the_window() {
        // A-7. The old gate logged and returned, so the panel review.js renders
        // could only be reached through a window Rust had already decided not
        // to open — a bumped protocol would leave the agent blocked forever on
        // a request nobody ever saw.
        let too_new = SUPPORTED_PROTOCOL_VERSION + 1;

        assert_eq!(envelope(too_new, "plan_review"), VersionVerdict::ShowUpgradePanel);
        assert_eq!(envelope(too_new, "question"), VersionVerdict::ShowUpgradePanel);
        assert_eq!(envelope(too_new, "notification"), VersionVerdict::ShowUpgradePanel);
    }

    #[test]
    fn an_unknown_future_message_type_still_reaches_the_window() {
        // The case this is actually for: a version bump that introduces a type
        // this build has never heard of. Defaulting to silence would recreate
        // the exact failure A-7 exists to prevent.
        assert_eq!(
            envelope(SUPPORTED_PROTOCOL_VERSION + 1, "plan_review_v2"),
            VersionVerdict::ShowUpgradePanel
        );
        assert_eq!(
            envelope(99, "something_invented_years_from_now"),
            VersionVerdict::ShowUpgradePanel
        );
    }

    #[test]
    fn a_too_new_settlement_message_is_ignored_without_a_window() {
        // These resolve something rather than ask for it, so nothing is
        // waiting. One panel per ack would bury the one panel that matters.
        let too_new = SUPPORTED_PROTOCOL_VERSION + 1;

        for msg_type in [
            "answer",
            "plan_review_response",
            "plan_review_ack",
            "cancel_review",
            "dismiss_notification",
            "restore_notification",
            "chunk",
        ] {
            assert_eq!(
                envelope(too_new, msg_type),
                VersionVerdict::Ignore,
                "{msg_type} should not open a window"
            );
        }
    }

    #[test]
    fn review_body_error_kinds_are_distinct_and_stable() {
        // These strings are a contract with review.js, not a log format.
        let cases: Vec<(ReviewBodyError, &str)> = vec![
            (ReviewBodyError::Payload(PayloadError::Expired), "expired"),
            (
                ReviewBodyError::Payload(PayloadError::HashMismatch {
                    expected: "a".into(),
                    actual: "b".into(),
                }),
                "hash_mismatch",
            ),
            (ReviewBodyError::Payload(PayloadError::Decrypt("x".into())), "decrypt"),
            (ReviewBodyError::Payload(PayloadError::Gunzip("x".into())), "corrupt"),
            (ReviewBodyError::Payload(PayloadError::Base64("x".into())), "corrupt"),
            (ReviewBodyError::Payload(PayloadError::Json("x".into())), "corrupt"),
            (
                ReviewBodyError::Payload(PayloadError::TooLarge { limit: 1 }),
                "corrupt",
            ),
            (ReviewBodyError::Payload(PayloadError::MissingData), "missing"),
            (ReviewBodyError::NoAttachment, "missing"),
            (ReviewBodyError::Network("timeout".into()), "unavailable"),
        ];

        for (error, expected) in cases {
            assert_eq!(error.kind(), expected, "{error}");
            assert!(!error.to_string().is_empty(), "every state needs words");
        }
    }
}

/// Characterization tests for the routing itself.
///
/// New coverage, not moved coverage: until `NtfySink` existed, `dispatch_message`
/// took an `&AppHandle` and could not be called from a test at all. A comment in
/// the old `ntfy.rs` said exactly that. This module is the entire justification
/// for the abstraction, so it pins the behaviour that was previously unpinned:
/// what reaches the host, how often, and what deliberately does not.
#[cfg(test)]
mod dispatch_tests {
    use super::*;
    use crate::ntfy::test_sink::RecordingSink;

    fn cfg() -> HitlConfig {
        HitlConfig { encryption_key: None, ..Default::default() }
    }

    #[tokio::test]
    async fn a_question_reaches_the_sink_once() {
        let sink = RecordingSink::default();
        let body = r#"{"type":"question","messageId":"q-1","timestamp":1,
                       "context":"c","question":"pick","options":[],
                       "allowMultiple":false,"allowOther":false,"repo":null}"#;
        let mut seen = SeenIds::default();
        dispatch_message(&sink, &cfg(), body, false, None, Origin::Live { seen: &mut seen }).await;
        assert_eq!(sink.calls(), vec!["Question(\"q-1\")"]);
    }

    #[tokio::test]
    async fn a_duplicate_is_dispatched_once() {
        let sink = RecordingSink::default();
        let body = r#"{"type":"notification","messageId":"n-1","timestamp":1,
                       "title":"t","body":"b"}"#;
        let mut seen = SeenIds::default();
        dispatch_message(&sink, &cfg(), body, false, None, Origin::Live { seen: &mut seen }).await;
        dispatch_message(&sink, &cfg(), body, false, None, Origin::Live { seen: &mut seen }).await;
        assert_eq!(sink.calls().len(), 1, "SeenIds must suppress the replay");
    }

    #[tokio::test]
    async fn a_restore_notification_reaches_the_sink_with_its_exact_dismissal() {
        let sink = RecordingSink::default();
        let body = r#"{"type":"restore_notification","messageId":"restore-1","timestamp":1,
                       "notificationId":"n-1","dismissalId":"dismiss-1","restoredFrom":"phone"}"#;
        let mut seen = SeenIds::default();

        dispatch_message(&sink, &cfg(), body, false, None, Origin::Live { seen: &mut seen }).await;

        assert_eq!(
            sink.calls(),
            vec!["RestoreNotification(\"n-1\", \"dismiss-1\")"]
        );
    }

    #[tokio::test]
    async fn a_cached_restore_notification_has_no_ui_side_effect() {
        let sink = RecordingSink::default();
        let body = r#"{"type":"restore_notification","messageId":"restore-1","timestamp":1,
                       "notificationId":"n-1","dismissalId":"dismiss-1","restoredFrom":"phone"}"#;
        let answered = HashSet::new();
        let mut seen = SeenIds::default();

        dispatch_message(
            &sink,
            &cfg(),
            body,
            false,
            None,
            Origin::Cache { answered_ids: &answered, seen: &mut seen },
        )
        .await;

        assert!(sink.calls().is_empty());
    }

    #[tokio::test]
    async fn a_too_new_restore_is_ignored_as_a_settlement() {
        let sink = RecordingSink::default();
        let v = SUPPORTED_PROTOCOL_VERSION + 1;
        let body = format!(
            r#"{{"type":"restore_notification","messageId":"restore-1","timestamp":1,
                 "protocolVersion":{v},"notificationId":"n-1","dismissalId":"dismiss-1",
                 "restoredFrom":"phone"}}"#
        );
        let mut seen = SeenIds::default();

        dispatch_message(&sink, &cfg(), &body, false, None, Origin::Live { seen: &mut seen }).await;

        assert!(sink.calls().is_empty(), "a settlement must not open an upgrade panel");
    }

    #[tokio::test]
    async fn a_too_new_settlement_message_is_ignored() {
        let sink = RecordingSink::default();
        let v = SUPPORTED_PROTOCOL_VERSION + 1;
        let body = format!(r#"{{"type":"plan_review_response","messageId":"r-1",
                               "timestamp":1,"protocolVersion":{v},"reviewId":"rev-1"}}"#);
        let mut seen = SeenIds::default();
        dispatch_message(&sink, &cfg(), &body, false, None, Origin::Live { seen: &mut seen }).await;
        assert!(sink.calls().is_empty(), "settlement messages must not raise an upgrade panel");
    }

    #[tokio::test]
    async fn a_too_new_message_a_human_waits_on_reports_unsupported() {
        let sink = RecordingSink::default();
        let v = SUPPORTED_PROTOCOL_VERSION + 1;
        let body = format!(r#"{{"type":"plan_review","messageId":"p-1",
                               "timestamp":1,"protocolVersion":{v}}}"#);
        let mut seen = SeenIds::default();
        dispatch_message(&sink, &cfg(), &body, false, None, Origin::Live { seen: &mut seen }).await;
        assert_eq!(sink.calls(), vec![format!("UnsupportedVersion(\"p-1\", {v})")]);
    }

    #[tokio::test]
    async fn garbage_is_dropped_without_panicking() {
        let sink = RecordingSink::default();
        let mut seen = SeenIds::default();
        for body in ["", "null", "{", r#"{"no":"type"}"#] {
            dispatch_message(&sink, &cfg(), body, false, None, Origin::Live { seen: &mut seen }).await;
        }
        assert!(sink.calls().is_empty());
    }
}
