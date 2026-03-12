#![windows_subsystem = "windows"]

mod config;
mod ntfy;
mod sound;
mod tray;
mod types;

use config::load_config;
use types::AnswerMessage;

/// Tauri command: submit an answer from the frontend.
#[tauri::command]
async fn submit_answer(
    question_id: String,
    selected_values: Vec<String>,
    other_text: Option<String>,
    skipped: bool,
) -> Result<(), String> {
    let config = load_config().map_err(|e| e.to_string())?;

    let answer = AnswerMessage {
        msg_type: "answer".to_string(),
        message_id: uuid::Uuid::new_v4().to_string(),
        question_id,
        timestamp: 0, // Will be set in publish_answer
        responded_from: config.device_name.clone(),
        selected_values,
        other_text,
        skipped,
    };

    ntfy::publish_answer(&config, &answer)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![submit_answer])
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
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                api.prevent_exit();
            }
        });
}
