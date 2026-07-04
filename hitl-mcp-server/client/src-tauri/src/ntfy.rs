use std::collections::HashSet;
use futures_util::StreamExt;
use reqwest::Client;
use tauri::{AppHandle, Emitter, Manager};

use crate::chunking::ChunkAssembler;
use crate::config::load_config;
use crate::crypto;
use crate::types::{AnswerMessage, ChunkMessage, DismissNotificationMessage, HitlConfig, NotificationMessage, QuestionMessage};

/// Start listening to ntfy for incoming question messages.
/// First polls cached messages to find pending (unanswered) questions,
/// then subscribes to live messages going forward.
pub async fn subscribe_loop(app: AppHandle) {
    let config = match load_config() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("HITL config error: {}", e);
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
    eprintln!("Fetching cached messages to find pending questions...");
    let cached_body = fetch_cached_body(&base_url).await;
    let answered_ids = extract_answered_ids(&cached_body, &config);
    eprintln!("Found {} answered questions in cache", answered_ids.len());

    // Show any pending (unanswered) questions from cache
    show_pending_from_cache(&app, &config, &cached_body, &answered_ids);

    // Phase 2: Subscribe to live messages (from just before cache poll to avoid gaps)
    let live_url = format!("{}/json?since={}", base_url, since_ts);
    eprintln!("Subscribing to live ntfy messages: {}", live_url);

    loop {
        match subscribe_live(&app, &config, &live_url).await {
            Ok(()) => eprintln!("ntfy stream ended, reconnecting in 5s..."),
            Err(e) => eprintln!("ntfy error: {}, reconnecting in 5s...", e),
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
            eprintln!("Cache poll returned {}", r.status());
            return String::new();
        }
        Err(e) => {
            eprintln!("Cache poll failed: {}", e);
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
                        eprintln!("Failed to decrypt message: {}", e);
                        return None;
                    }
                }
            } else {
                eprintln!("Received encrypted message but no encryptionKey configured — skipping");
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

/// Extract answered question IDs from a cached message body.
fn extract_answered_ids(body: &str, config: &HitlConfig) -> HashSet<String> {
    let mut answered = HashSet::new();
    for line in body.lines() {
        let line = line.trim();
        if line.is_empty() { continue; }

        if let Ok(ntfy_event) = serde_json::from_str::<serde_json::Value>(line) {
            if let Some(msg_str) = ntfy_event.get("message").and_then(|m| m.as_str()) {
                if let Some((decrypted, _)) = try_decrypt(msg_str, config) {
                    if let Ok(answer) = serde_json::from_str::<AnswerMessage>(&decrypted) {
                        if answer.msg_type == "answer" {
                            answered.insert(answer.question_id.clone());
                        }
                    }
                }
            }
        }
    }
    answered
}

/// Decrypt every cached line and reassemble any chunked messages, in order.
fn decrypt_and_reassemble_cache(body: &str, config: &HitlConfig) -> Vec<(String, bool)> {
    let mut assembler = ChunkAssembler::new();
    let mut messages = Vec::new();

    for line in body.lines() {
        let line = line.trim();
        if line.is_empty() { continue; }

        if let Ok(ntfy_event) = serde_json::from_str::<serde_json::Value>(line) {
            if let Some(msg_str) = ntfy_event.get("message").and_then(|m| m.as_str()) {
                if let Some((decrypted, was_encrypted)) = try_decrypt(msg_str, config) {
                    if let Some(resolved) =
                        resolve_chunked_message(&decrypted, was_encrypted, config, &mut assembler)
                    {
                        messages.push(resolved);
                    }
                }
            }
        }
    }

    messages
}

/// Show pending (unanswered) questions from the already-fetched cache body.
fn show_pending_from_cache(
    app: &AppHandle,
    config: &HitlConfig,
    body: &str,
    answered_ids: &HashSet<String>,
) {
    if body.is_empty() { return; }

    let messages = decrypt_and_reassemble_cache(body, config);

    // First pass: collect dismissed notification IDs
    let mut dismissed_notifications: HashSet<String> = HashSet::new();
    for (decrypted, _) in &messages {
        if let Ok(dismiss) = serde_json::from_str::<DismissNotificationMessage>(decrypted) {
            if dismiss.msg_type == "dismiss_notification" {
                dismissed_notifications.insert(dismiss.notification_id.clone());
            }
        }
    }

    // Second pass: show only pending questions and undismissed notifications
    for (decrypted, was_encrypted) in &messages {
        if let Ok(question) = serde_json::from_str::<QuestionMessage>(decrypted) {
            if question.msg_type == "question" && !answered_ids.contains(&question.message_id) {
                eprintln!("Showing pending question from cache: {}", question.message_id);
                show_question(app, config, &question, *was_encrypted);
            }
        }
        // We intentionally skip cached notifications — they're ephemeral
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

            if let Ok(ntfy_event) = serde_json::from_str::<serde_json::Value>(&line) {
                if let Some(message_str) = ntfy_event.get("message").and_then(|m| m.as_str()) {
                    if let Some((decrypted, was_encrypted)) = try_decrypt(message_str, config) {
                        if let Some((final_body, final_encrypted)) =
                            resolve_chunked_message(&decrypted, was_encrypted, config, &mut assembler)
                        {
                            handle_live_message(app, config, &final_body, final_encrypted).await;
                        }
                    }
                }
            }
        }
    }

    Ok(())
}

/// Handle a live (new) message — show questions, dismiss on answers, show notifications.
async fn handle_live_message(app: &AppHandle, config: &HitlConfig, raw: &str, was_encrypted: bool) {
    // Try to parse as a question
    if let Ok(question) = serde_json::from_str::<QuestionMessage>(raw) {
        if question.msg_type == "question" {
            eprintln!("Received question: {}", question.message_id);
            show_question(app, config, &question, was_encrypted);
            return;
        }
    }

    // Try to parse as an answer
    if let Ok(answer) = serde_json::from_str::<AnswerMessage>(raw) {
        if answer.msg_type == "answer" {
            eprintln!(
                "Received answer for question {}: from {}",
                answer.question_id, answer.responded_from
            );

            if let Err(e) = app.emit("dismiss-question", &answer) {
                eprintln!("Failed to emit dismiss-question: {}", e);
            }

            let label = format!("dialog-{}", &answer.question_id[..8.min(answer.question_id.len())]);
            if let Some(window) = app.get_webview_window(&label) {
                let _ = window.close();
            }
            return;
        }
    }

    // Try to parse as a notification
    if let Ok(notification) = serde_json::from_str::<NotificationMessage>(raw) {
        if notification.msg_type == "notification" {
            eprintln!("Received notification: {}", notification.message_id);

            if config.sound_enabled {
                crate::sound::play_notification();
            }

            // Build a payload that includes the encrypted flag for the frontend
            let mut payload = serde_json::to_value(&notification).unwrap_or_default();
            if let Some(obj) = payload.as_object_mut() {
                obj.insert("_wasEncrypted".to_string(), serde_json::Value::Bool(was_encrypted));
            }
            let notification_json = serde_json::to_string(&payload).unwrap_or_default();
            let label = "notifications";
            let window = app.get_webview_window(label);

            if let Some(win) = window {
                if let Err(e) = win.emit("add-notification", &notification_json) {
                    eprintln!("Failed to emit add-notification: {}", e);
                }
                let _ = win.show();
            } else {
                let encoded = urlencoding::encode(&notification_json);
                let url_str = format!("notifications.html?notification={}", encoded);

                match tauri::WebviewWindowBuilder::new(
                    app,
                    label,
                    tauri::WebviewUrl::App(url_str.into()),
                )
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
                    Ok(_) => eprintln!("Notifications window created"),
                    Err(e) => eprintln!("Failed to create notifications window: {}", e),
                }
            }
            return;
        }
    }

    // Try to parse as a dismiss-notification
    if let Ok(dismiss) = serde_json::from_str::<DismissNotificationMessage>(raw) {
        if dismiss.msg_type == "dismiss_notification" {
            eprintln!(
                "Received dismiss for notification {}: from {}",
                dismiss.notification_id, dismiss.dismissed_from
            );

            if let Some(win) = app.get_webview_window("notifications") {
                if let Err(e) = win.emit("remove-notification", &dismiss.notification_id) {
                    eprintln!("Failed to emit remove-notification: {}", e);
                }
            }
        }
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
        Ok(_) => eprintln!("Dialog window created: {}", label),
        Err(e) => eprintln!("Failed to create dialog window: {}", e),
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
