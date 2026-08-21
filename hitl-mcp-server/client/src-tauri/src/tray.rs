use std::sync::atomic::{AtomicBool, Ordering};
use hitl_transport::status::{now_millis, ConnectionStatus};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager,
};

/// Flag set by the tray Quit handler so the ExitRequested handler in main()
/// knows to allow the exit instead of calling prevent_exit().
pub static QUIT_REQUESTED: AtomicBool = AtomicBool::new(false);

/// How often the tray status line is rebuilt.
const STATUS_REFRESH: std::time::Duration = std::time::Duration::from_secs(10);

/// Set up the system tray icon and menu.
pub fn setup_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let state = app.state::<ConnectionStatus>();
    let status = MenuItem::with_id(
        app,
        "status",
        state.status_label(now_millis()),
        false,
        None::<&str>,
    )?;
    let open_log = MenuItem::with_id(app, "open_log", "Open Log", true, None::<&str>)?;
    let cancel_review = MenuItem::with_id(
        app,
        "cancel_review",
        "Cancel Pending Review",
        true,
        None::<&str>,
    )?;
    let separator = MenuItem::with_id(app, "sep", "---", false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[&status, &open_log, &cancel_review, &separator, &quit],
    )?;

    let icon = Image::from_bytes(include_bytes!("../icons/icon.png"))?;

    let _tray = TrayIconBuilder::new()
        .icon(icon)
        .tooltip("HITL - Human in the Loop")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "quit" => {
                QUIT_REQUESTED.store(true, Ordering::SeqCst);
                app.exit(0);
            }
            "open_log" => open_log_file(app),
            "cancel_review" => cancel_pending_reviews(app),
            _ => {}
        })
        .build(app)?;

    // The status item is only useful if it keeps telling the truth.
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(STATUS_REFRESH).await;
            let label = handle.state::<ConnectionStatus>().status_label(now_millis());
            if let Err(e) = status.set_text(&label) {
                log::warn!("Failed to refresh tray status: {}", e);
            }
        }
    });

    Ok(())
}

/// Open `~/.hitl/client.log` in whatever the OS uses for text.
fn open_log_file(_app: &AppHandle) {
    let Some(path) = crate::logging::log_path() else {
        log::error!("No home directory, so there is no log file to open");
        return;
    };

    if !path.exists() {
        log::warn!("No log file at {} yet", path.display());
        return;
    }

    match crate::opener::spawn(&path) {
        Ok(()) => log::info!("Opened {}", path.display()),
        Err(e) => log::error!("{}", e),
    }
}

/// Release every agent still blocked on a review from this client.
///
/// Closing a review window resolves nothing — the agent goes on waiting, now
/// with no timeout to rescue it. This is the escape hatch: it publishes a real
/// `cancelled` verdict, which is what the agent is actually listening for.
fn cancel_pending_reviews(app: &AppHandle) {
    let outstanding = app.state::<hitl_transport::ntfy::review::OutstandingReviews>().snapshot();
    if outstanding.is_empty() {
        log::info!("Tray cancel: no reviews are outstanding");
        return;
    }

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        for (review_id, snapshot_hash) in outstanding {
            log::info!("Tray cancel: releasing the agent blocked on review {}", review_id);
            let body = hitl_transport::types::PlanReviewResponseBody {
                overall_feedback: "Review cancelled from the HITL tray.".to_string(),
                inline_comments: Vec::new(),
            };

            // Encryption follows the config: a client with a key configured is
            // talking to a server that expects one.
            let encrypted = hitl_transport::config::load_config()
                .map(|c| c.encryption_key.is_some())
                .unwrap_or(false);

            if let Err(e) = crate::ntfy::submit_review_response(
                &handle,
                review_id.clone(),
                snapshot_hash,
                "cancelled".to_string(),
                body,
                encrypted,
            )
            .await
            {
                log::error!("Tray cancel of review {} failed: {}", review_id, e);
            }
        }
    });
}
