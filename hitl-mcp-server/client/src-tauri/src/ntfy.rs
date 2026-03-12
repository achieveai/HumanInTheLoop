use std::time::{SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use reqwest::Client;
use tauri::{AppHandle, Emitter, Manager};

use crate::config::load_config;
use crate::types::{AnswerMessage, HitlConfig, QuestionMessage};

/// Start listening to ntfy for incoming question messages.
/// Emits `show-question` events to the Tauri frontend when a question arrives.
/// Emits `dismiss-question` events when an answer for an open question arrives.
pub async fn subscribe_loop(app: AppHandle) {
    let config = match load_config() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("HITL config error: {}", e);
            return;
        }
    };

    let since_ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let url = format!(
        "{}/{}/json?since={}",
        config.ntfy_url.trim_end_matches('/'),
        config.topic_id,
        since_ts
    );

    eprintln!("Subscribing to ntfy: {}", url);

    loop {
        match subscribe_once(&app, &config, &url).await {
            Ok(()) => eprintln!("ntfy stream ended, reconnecting in 5s..."),
            Err(e) => eprintln!("ntfy error: {}, reconnecting in 5s...", e),
        }
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    }
}

async fn subscribe_once(
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

    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(newline_pos) = buffer.find('\n') {
            let line = buffer[..newline_pos].trim().to_string();
            buffer = buffer[newline_pos + 1..].to_string();

            if line.is_empty() {
                continue;
            }

            // ntfy wraps messages in an envelope with an event type and message field
            if let Ok(ntfy_event) = serde_json::from_str::<serde_json::Value>(&line) {
                if let Some(message_str) = ntfy_event.get("message").and_then(|m| m.as_str()) {
                    handle_message(app, config, message_str).await;
                }
            }
        }
    }

    Ok(())
}

async fn handle_message(app: &AppHandle, config: &HitlConfig, raw: &str) {
    // Try to parse as a question
    if let Ok(question) = serde_json::from_str::<QuestionMessage>(raw) {
        if question.msg_type == "question" {
            eprintln!("Received question: {}", question.message_id);

            // Play notification sound if enabled
            if config.sound_enabled {
                crate::sound::play_notification();
            }

            // Store the question data in Tauri state so the frontend can fetch it
            let question_json = serde_json::to_string(&question).unwrap_or_default();
            let label = format!("dialog-{}", &question.message_id[..8]);

            // Build the window with question data encoded in the URL fragment
            let encoded = urlencoding::encode(&question_json);
            let url_str = format!("index.html?question={}", encoded);

            match tauri::WebviewWindowBuilder::new(
                app,
                &label,
                tauri::WebviewUrl::App(url_str.into()),
            )
            .title("HITL")
            .inner_size(400.0, 700.0)
            .center()
            .resizable(true)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .focused(true)
            .build()
            {
                Ok(_) => eprintln!("Dialog window created: {}", label),
                Err(e) => eprintln!("Failed to create dialog window: {}", e),
            }

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

            // Emit dismiss event to all windows
            if let Err(e) = app.emit("dismiss-question", &answer) {
                eprintln!("Failed to emit dismiss-question: {}", e);
            }

            // Close the dialog window if it exists
            let label = format!("dialog-{}", &answer.question_id[..8.min(answer.question_id.len())]);
            if let Some(window) = app.get_webview_window(&label) {
                let _ = window.close();
            }
        }
    }
}

/// Publish an answer message to ntfy.
pub async fn publish_answer(
    config: &HitlConfig,
    answer: &AnswerMessage,
) -> Result<(), Box<dyn std::error::Error>> {
    let url = format!(
        "{}/{}",
        config.ntfy_url.trim_end_matches('/'),
        config.topic_id
    );

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;

    let mut answer = answer.clone();
    answer.timestamp = now;

    let client = Client::new();
    let response = client
        .post(&url)
        .header("Content-Type", "application/json")
        .body(serde_json::to_string(&answer)?)
        .send()
        .await?;

    if !response.status().is_success() {
        return Err(format!("ntfy publish failed: {}", response.status()).into());
    }

    Ok(())
}
