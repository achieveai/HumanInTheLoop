use std::collections::HashSet;
use futures_util::StreamExt;
use reqwest::Client;
use tauri::{AppHandle, Emitter, Manager};

use crate::chunking::ChunkAssembler;
use crate::config::load_config;
use crate::crypto;
use crate::types::{
    AnswerMessage, AttachmentRef, ChunkMessage, DismissNotificationMessage, HitlConfig,
    MessageEnvelope, NotificationMessage, QuestionMessage, SUPPORTED_PROTOCOL_VERSION,
};

/// Start listening to ntfy for incoming question messages.
/// First polls cached messages to find pending (unanswered) questions,
/// then subscribes to live messages going forward.
pub async fn subscribe_loop(app: AppHandle) {
    let config = match load_config() {
        Ok(c) => c,
        Err(e) => {
            log::error!("HITL config error: {}", e);
            return;
        }
    };

    let base_url = format!(
        "{}/{}",
        config.ntfy_url.trim_end_matches('/'),
        config.topic_id
    );

    // Capture timestamp before cache poll so live subscription covers the gap
    let since_ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();

    // Phase 1: Poll all cached messages once, then process
    log::info!("Fetching cached messages to find pending questions...");
    let cached_body = fetch_cached_body(&base_url).await;
    let answered_ids = extract_answered_ids(&cached_body, &config);
    log::info!("Found {} answered questions in cache", answered_ids.len());

    // Show any pending (unanswered) questions from cache
    show_pending_from_cache(&app, &config, &cached_body, &answered_ids).await;

    // Phase 2: Subscribe to live messages (from just before cache poll to avoid gaps)
    let live_url = format!("{}/json?since={}", base_url, since_ts);
    log::info!("Subscribing to live ntfy messages: {}", live_url);

    loop {
        match subscribe_live(&app, &config, &live_url).await {
            Ok(()) => log::warn!("ntfy stream ended, reconnecting in 5s..."),
            Err(e) => log::warn!("ntfy error: {}, reconnecting in 5s...", e),
        }
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    }
}

/// Fetch all cached messages from ntfy as a single body string.
async fn fetch_cached_body(base_url: &str) -> String {
    let poll_url = format!("{}/json?since=all&poll=1", base_url);

    let client = Client::new();
    let response = match client
        .get(&poll_url)
        .header("Accept", "application/x-ndjson")
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r,
        Ok(r) => {
            log::warn!("Cache poll returned {}", r.status());
            return String::new();
        }
        Err(e) => {
            log::warn!("Cache poll failed: {}", e);
            return String::new();
        }
    };

    response.text().await.unwrap_or_default()
}

/// Try to decrypt a raw message string.
/// Returns Some((json_string, was_encrypted)) on success, or None if the message
/// should be skipped (encrypted but no key, or decryption failed).
fn try_decrypt(raw: &str, config: &HitlConfig) -> Option<(String, bool)> {
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
fn resolve_chunked_message(
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

/// Pull the message body and ntfy's own attachment metadata off one raw event line.
///
/// All three readers previously kept only `message` and discarded the rest of
/// the event, which left an attachment-backed payload with nowhere to arrive —
/// the attachment URL exists only on the ntfy envelope, never inside our own
/// message, because it is assigned by the PUT.
fn parse_ntfy_event(line: &str) -> Option<(String, Option<AttachmentRef>)> {
    let event: serde_json::Value = serde_json::from_str(line).ok()?;
    let message = event.get("message")?.as_str()?.to_string();

    let attachment = event
        .get("attachment")
        .and_then(|a| serde_json::from_value::<AttachmentRef>(a.clone()).ok())
        .filter(|a| !a.url.is_empty());

    Some((message, attachment))
}

/// Extract answered question IDs from a cached message body.
fn extract_answered_ids(body: &str, config: &HitlConfig) -> HashSet<String> {
    let mut answered = HashSet::new();
    for line in body.lines() {
        let line = line.trim();
        if line.is_empty() { continue; }

        if let Some((msg_str, _attachment)) = parse_ntfy_event(line) {
            if let Some((decrypted, _)) = try_decrypt(&msg_str, config) {
                if let Ok(answer) = serde_json::from_str::<AnswerMessage>(&decrypted) {
                    if answer.msg_type == "answer" {
                        answered.insert(answer.question_id.clone());
                    }
                }
            }
        }
    }
    answered
}

/// Decrypt every cached line and reassemble any chunked messages, in order.
fn decrypt_and_reassemble_cache(
    body: &str,
    config: &HitlConfig,
) -> Vec<(String, bool, Option<AttachmentRef>)> {
    let mut assembler = ChunkAssembler::new();
    let mut messages = Vec::new();

    for line in body.lines() {
        let line = line.trim();
        if line.is_empty() { continue; }

        if let Some((msg_str, attachment)) = parse_ntfy_event(line) {
            if let Some((decrypted, was_encrypted)) = try_decrypt(&msg_str, config) {
                if let Some((resolved, resolved_encrypted)) =
                    resolve_chunked_message(&decrypted, was_encrypted, config, &mut assembler)
                {
                    messages.push((resolved, resolved_encrypted, attachment));
                }
            }
        }
    }

    messages
}

/// Show pending (unanswered) questions from the already-fetched cache body.
///
/// Routes through the same dispatch as live messages rather than keeping a
/// second, subtly-different type chain — the two used to disagree about which
/// types they recognized.
async fn show_pending_from_cache(
    app: &AppHandle,
    config: &HitlConfig,
    body: &str,
    answered_ids: &HashSet<String>,
) {
    if body.is_empty() { return; }

    for (decrypted, was_encrypted, attachment) in decrypt_and_reassemble_cache(body, config) {
        dispatch_message(
            app,
            config,
            &decrypted,
            was_encrypted,
            attachment,
            Origin::Cache { answered_ids },
        )
        .await;
    }
}

/// Subscribe to live (new) messages from ntfy.
async fn subscribe_live(
    app: &AppHandle,
    config: &HitlConfig,
    url: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let client = Client::new();
    let response = client
        .get(url)
        .header("Accept", "application/x-ndjson")
        .send()
        .await?;

    if !response.status().is_success() {
        return Err(format!("ntfy returned {}", response.status()).into());
    }

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut assembler = ChunkAssembler::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(newline_pos) = buffer.find('\n') {
            let line = buffer[..newline_pos].trim().to_string();
            buffer = buffer[newline_pos + 1..].to_string();

            if line.is_empty() {
                continue;
            }

            if let Some((message_str, attachment)) = parse_ntfy_event(&line) {
                if let Some((decrypted, was_encrypted)) = try_decrypt(&message_str, config) {
                    if let Some((final_body, final_encrypted)) =
                        resolve_chunked_message(&decrypted, was_encrypted, config, &mut assembler)
                    {
                        dispatch_message(
                            app,
                            config,
                            &final_body,
                            final_encrypted,
                            attachment,
                            Origin::Live,
                        )
                        .await;
                    }
                }
            }
        }
    }

    Ok(())
}

/// Where a message came from.
///
/// Cached messages are replayed on every startup, so they must not resurrect
/// ephemeral UI or re-show a question that has already been answered. Dispatch
/// consults this instead of keeping a second, subtly-different type chain —
/// the live and cache chains used to disagree about which types they handled.
enum Origin<'a> {
    Live,
    Cache { answered_ids: &'a HashSet<String> },
}

/// Route one decrypted, fully-reassembled message to its handler.
///
/// Envelope-first: the concrete type is chosen by `type`, not guessed by trying
/// four `serde_json::from_str` calls in sequence. The old chain had no terminal
/// branch, so any message it could not parse vanished — no window, no log — and
/// a blocked agent would wait forever for an answer that could never arrive.
async fn dispatch_message(
    app: &AppHandle,
    config: &HitlConfig,
    raw: &str,
    was_encrypted: bool,
    attachment: Option<AttachmentRef>,
    origin: Origin<'_>,
) {
    let env = match serde_json::from_str::<MessageEnvelope>(raw) {
        Ok(env) => env,
        Err(e) => {
            log::warn!("Undecodable message envelope: {}", e);
            return;
        }
    };

    if env.version() > SUPPORTED_PROTOCOL_VERSION {
        // The visible "needs a newer HITL client" panel lands with the review
        // window. Until then this is at least named in the log rather than
        // dropped on the floor.
        log::warn!(
            "Message {} declares protocolVersion {} but this client supports {} — ignoring",
            env.message_id,
            env.version(),
            SUPPORTED_PROTOCOL_VERSION
        );
        return;
    }

    match env.msg_type.as_str() {
        "question" => match serde_json::from_str::<QuestionMessage>(raw) {
            Ok(question) => {
                if let Origin::Cache { answered_ids } = origin {
                    if answered_ids.contains(&question.message_id) {
                        return;
                    }
                    log::info!("Showing pending question from cache: {}", question.message_id);
                } else {
                    log::info!("Received question: {}", question.message_id);
                }
                show_question(app, config, &question, was_encrypted);
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

                    if let Err(e) = app.emit("dismiss-question", &answer) {
                        log::error!("Failed to emit dismiss-question: {}", e);
                    }

                    let label = format!(
                        "dialog-{}",
                        &answer.question_id[..8.min(answer.question_id.len())]
                    );
                    if let Some(window) = app.get_webview_window(&label) {
                        let _ = window.close();
                    }
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
                Ok(notification) => show_notification(app, config, &notification, was_encrypted),
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

                    if let Some(win) = app.get_webview_window("notifications") {
                        if let Err(e) = win.emit("remove-notification", &dismiss.notification_id) {
                            log::error!("Failed to emit remove-notification: {}", e);
                        }
                    }
                }
                Err(e) => log::error!("dismiss_notification {} parse failed: {}", env.message_id, e),
            }
        }

        // The plan-review types. S0 lands the wire contract and this routing;
        // the handlers land with the review window. Named in the log so a
        // message arriving against a build without them is visible.
        "plan_review" | "plan_review_ack" | "cancel_review" => log::warn!(
            "Received {} {} (protocolVersion {}, {} payload) — no handler in this build",
            env.msg_type,
            env.message_id,
            env.version(),
            if attachment.is_some() { "attachment" } else { "inline" }
        ),

        // Ours-outbound, or transport-internal and already reassembled upstream.
        // Never a warning.
        "plan_review_response" | "chunk" => {}

        other => log::warn!(
            "Unrecognized message type '{}' (id {})",
            other, env.message_id
        ),
    }
}

/// Show (or update) the notifications window for an incoming notification.
fn show_notification(
    app: &AppHandle,
    config: &HitlConfig,
    notification: &NotificationMessage,
    was_encrypted: bool,
) {
    log::info!("Received notification: {}", notification.message_id);

    if config.sound_enabled {
        crate::sound::play_notification();
    }

    // Build a payload that includes the encrypted flag for the frontend
    let mut payload = serde_json::to_value(notification).unwrap_or_default();
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("_wasEncrypted".to_string(), serde_json::Value::Bool(was_encrypted));
    }
    let notification_json = serde_json::to_string(&payload).unwrap_or_default();
    let label = "notifications";

    if let Some(win) = app.get_webview_window(label) {
        if let Err(e) = win.emit("add-notification", &notification_json) {
            log::error!("Failed to emit add-notification: {}", e);
        }
        let _ = crate::window_utils::show_window_no_activate(&win);
        return;
    }

    let encoded = urlencoding::encode(&notification_json);
    let url_str = format!("notifications.html?notification={}", encoded);

    match tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::App(url_str.into()))
        .title("Notifications")
        .inner_size(400.0, 500.0)
        .center()
        .resizable(true)
        .decorations(false)
        .always_on_top(true)
        .visible(false)
        .focused(false)
        .build()
    {
        Ok(_) => log::info!("Notifications window created"),
        Err(e) => log::error!("Failed to create notifications window: {}", e),
    }
}

/// Create and show a dialog window for a question.
fn show_question(app: &AppHandle, config: &HitlConfig, question: &QuestionMessage, encrypted: bool) {
    if config.sound_enabled {
        crate::sound::play_notification();
    }

    let question_json = serde_json::to_string(question).unwrap_or_default();
    let id_prefix_len = 8.min(question.message_id.len());
    let label = format!("dialog-{}", &question.message_id[..id_prefix_len]);
    let encoded = urlencoding::encode(&question_json);
    let url_str = format!("index.html?question={}&encrypted={}", encoded, encrypted);

    match tauri::WebviewWindowBuilder::new(
        app,
        &label,
        tauri::WebviewUrl::App(url_str.into()),
    )
    .title("HITL")
    .inner_size(768.0, 768.0)
    .center()
    .resizable(true)
    .decorations(false)
    .always_on_top(true)
    .visible(false)
    .focused(false)
    .build()
    {
        Ok(_) => log::info!("Dialog window created: {}", label),
        Err(e) => log::error!("Failed to create dialog window: {}", e),
    }
}

/// Publish an answer message to ntfy.
/// If `encrypted` is true and config has an encryption key, the message is encrypted.
pub async fn publish_answer(
    config: &HitlConfig,
    answer: &AnswerMessage,
    encrypted: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    publish_message(config, &serde_json::to_string(answer)?, encrypted).await
}

/// Publish a dismiss-notification message to ntfy.
/// If `encrypted` is true and config has an encryption key, the message is encrypted.
pub async fn publish_dismiss_notification(
    config: &HitlConfig,
    msg: &DismissNotificationMessage,
    encrypted: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    publish_message(config, &serde_json::to_string(msg)?, encrypted).await
}

/// Publish a raw JSON message to ntfy, optionally encrypting it.
async fn publish_message(
    config: &HitlConfig,
    body: &str,
    encrypted: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let url = format!(
        "{}/{}",
        config.ntfy_url.trim_end_matches('/'),
        config.topic_id
    );

    let final_body = if encrypted {
        if let Some(ref key) = config.encryption_key {
            crypto::encrypt(body, key).map_err(|e| -> Box<dyn std::error::Error> { e.into() })?
        } else {
            body.to_string()
        }
    } else {
        body.to_string()
    };

    let client = Client::new();
    let response = client
        .post(&url)
        .header("Content-Type", "application/json")
        .body(final_body)
        .send()
        .await?;

    if !response.status().is_success() {
        return Err(format!("ntfy publish failed: {}", response.status()).into());
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Exact event shape returned by GET /{topic}/json, captured from ntfy.sh.
    const EVENT_WITH_ATTACHMENT: &str = r#"{"id":"abc","time":1786504137,"event":"message",
        "topic":"t","message":"{\"type\":\"plan_review\"}",
        "attachment":{"name":"qurRQchLV1Fb.bin","type":"application/octet-stream",
        "size":5000,"expires":1786514937,"url":"https://ntfy.sh/file/qurRQchLV1Fb.bin"}}"#;

    #[test]
    fn parse_ntfy_event_lifts_the_message_and_the_attachment() {
        let (message, attachment) = parse_ntfy_event(EVENT_WITH_ATTACHMENT).unwrap();

        assert_eq!(message, r#"{"type":"plan_review"}"#);
        let att = attachment.expect("attachment metadata must survive the reader");
        assert_eq!(att.url, "https://ntfy.sh/file/qurRQchLV1Fb.bin");
        assert_eq!(att.name, "qurRQchLV1Fb.bin");
        assert_eq!(att.size, Some(5000));
        assert_eq!(att.expires, Some(1786514937));
    }

    #[test]
    fn parse_ntfy_event_yields_no_attachment_for_an_ordinary_message() {
        let line =
            r#"{"id":"abc","event":"message","topic":"t","message":"{\"type\":\"question\"}"}"#;

        let (message, attachment) = parse_ntfy_event(line).unwrap();
        assert_eq!(message, r#"{"type":"question"}"#);
        assert!(attachment.is_none());
    }

    #[test]
    fn parse_ntfy_event_discards_attachment_metadata_with_no_url() {
        // Nothing can be fetched without a URL, so it must not look present.
        let line = r#"{"message":"{}","attachment":{"name":"x.bin","size":1}}"#;

        assert!(parse_ntfy_event(line).unwrap().1.is_none());
    }

    #[test]
    fn parse_ntfy_event_skips_events_that_carry_no_message() {
        // ntfy sends open and keepalive events on the same stream.
        assert!(parse_ntfy_event(r#"{"id":"abc","event":"keepalive","topic":"t"}"#).is_none());
        assert!(parse_ntfy_event("not json at all").is_none());
        assert!(parse_ntfy_event(r#"{"message":42}"#).is_none());
    }
}
