#![windows_subsystem = "windows"]

mod chunking;
mod config;
mod crypto;
mod ntfy;
mod payload;
mod payload_store;
mod sound;
mod tray;
mod types;
mod window_utils;

use config::load_config;
use types::{AnswerMessage, DismissNotificationMessage, SubAnswer};

/// Tauri command: submit an answer from the frontend.
#[tauri::command]
async fn submit_answer(
    question_id: String,
    selected_values: Vec<String>,
    other_text: Option<String>,
    skipped: bool,
    sub_answers: Option<Vec<SubAnswer>>,
    encrypted: Option<bool>,
) -> Result<(), String> {
    let config = load_config().map_err(|e| e.to_string())?;

    let answer = AnswerMessage {
        msg_type: "answer".to_string(),
        message_id: uuid::Uuid::new_v4().to_string(),
        question_id,
        timestamp: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64,
        responded_from: config.device_name.clone(),
        selected_values,
        other_text,
        skipped,
        sub_answers,
    };

    ntfy::publish_answer(&config, &answer, encrypted.unwrap_or(false))
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Tauri command: show the calling window without letting it steal OS keyboard focus.
#[tauri::command]
fn show_no_activate(window: tauri::WebviewWindow) -> Result<(), String> {
    window_utils::show_window_no_activate(&window).map_err(|e| e.to_string())
}

/// Tauri command: dismiss a notification from the frontend.
#[tauri::command]
async fn dismiss_notification(notification_id: String, encrypted: Option<bool>) -> Result<(), String> {
    let config = load_config().map_err(|e| e.to_string())?;

    let msg = DismissNotificationMessage {
        msg_type: "dismiss_notification".to_string(),
        message_id: uuid::Uuid::new_v4().to_string(),
        timestamp: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64,
        notification_id,
        dismissed_from: config.device_name.clone(),
    };

    ntfy::publish_dismiss_notification(&config, &msg, encrypted.unwrap_or(false))
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(payload_store::PayloadStore::default())
        .invoke_handler(tauri::generate_handler![submit_answer, dismiss_notification, show_no_activate, payload_store::take_window_payload])
        .setup(|app| {
            // Setup system tray
            tray::setup_tray(app.handle())?;

            // Start ntfy subscription in background
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                ntfy::subscribe_loop(handle).await;
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building HITL client")
        .run(|_app, event| {
            // Prevent the app from exiting when the last window closes.
            // The tray icon keeps the app alive so it can receive new questions.
            // But allow exit when the user clicks Quit in the tray menu.
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if !tray::QUIT_REQUESTED.load(std::sync::atomic::Ordering::SeqCst) {
                    api.prevent_exit();
                }
            }
        });
}
