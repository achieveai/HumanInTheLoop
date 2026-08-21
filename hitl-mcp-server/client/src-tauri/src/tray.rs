use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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

/// Live view of the ntfy subscription, shown in the tray.
///
/// The tray used to claim "HITL — Connected" unconditionally, from a string
/// baked in at startup. Since the client is otherwise silent — no console, and
/// until now no log — a dead subscription looked exactly like a healthy one.
#[derive(Default)]
pub struct AppState {
    connected: AtomicBool,
    /// Unix millis of the last ntfy event seen. 0 when there has not been one.
    last_message_ms: AtomicU64,
}

impl AppState {
    pub fn mark_connected(&self, connected: bool) {
        self.connected.store(connected, Ordering::Relaxed);
    }

    pub fn mark_message(&self) {
        self.last_message_ms.store(now_millis(), Ordering::Relaxed);
    }

    /// The tray line for this state at `now_ms`.
    ///
    /// Pure so the wording can be tested without a running tray. The message
    /// age is what makes a hard-killed agent visible: nothing can publish a
    /// notice of its own SIGKILL, so staleness is the only available signal.
    pub fn status_label(&self, now_ms: u64) -> String {
        if !self.connected.load(Ordering::Relaxed) {
            return "HITL — Disconnected".to_string();
        }

        match self.last_message_ms.load(Ordering::Relaxed) {
            0 => "HITL — Connected".to_string(),
            last => format!(
                "HITL — Connected (last message {})",
                format_age(now_ms.saturating_sub(last))
            ),
        }
    }
}

/// "just now" / "45s ago" / "3m ago" / "2h ago" / "4d ago".
fn format_age(elapsed_ms: u64) -> String {
    let secs = elapsed_ms / 1000;
    match secs {
        0..=9 => "just now".to_string(),
        10..=59 => format!("{secs}s ago"),
        60..=3599 => format!("{}m ago", secs / 60),
        3600..=86_399 => format!("{}h ago", secs / 3600),
        _ => format!("{}d ago", secs / 86_400),
    }
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Set up the system tray icon and menu.
pub fn setup_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let state = app.state::<AppState>();
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
            let label = handle.state::<AppState>().status_label(now_millis());
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
    let outstanding = app.state::<crate::ntfy::OutstandingReviews>().snapshot();
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

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_786_543_402_123;

    #[test]
    fn status_says_disconnected_before_the_first_successful_subscribe() {
        // The old tray was a hardcoded "Connected" string, which is exactly
        // what made a dead subscription indistinguishable from a healthy one.
        let state = AppState::default();
        assert_eq!(state.status_label(NOW), "HITL — Disconnected");
    }

    #[test]
    fn status_says_connected_before_any_message_has_arrived() {
        let state = AppState::default();
        state.mark_connected(true);

        assert_eq!(state.status_label(NOW), "HITL — Connected");
    }

    #[test]
    fn status_reports_how_stale_the_connection_is() {
        let state = AppState::default();
        state.mark_connected(true);
        state.last_message_ms.store(NOW - 7 * 60 * 1000, Ordering::Relaxed);

        assert_eq!(state.status_label(NOW), "HITL — Connected (last message 7m ago)");
    }

    #[test]
    fn losing_the_stream_overrides_a_recent_message() {
        let state = AppState::default();
        state.mark_connected(true);
        state.mark_message();
        state.mark_connected(false);

        assert_eq!(state.status_label(NOW), "HITL — Disconnected");
    }

    #[test]
    fn age_never_reads_as_the_future_when_the_clock_moves_backwards() {
        // NTP correction or a suspend/resume can put `now` behind the stamp.
        let state = AppState::default();
        state.mark_connected(true);
        state.last_message_ms.store(NOW + 60_000, Ordering::Relaxed);

        assert_eq!(state.status_label(NOW), "HITL — Connected (last message just now)");
    }

    #[test]
    fn age_scales_from_seconds_to_days() {
        assert_eq!(format_age(0), "just now");
        assert_eq!(format_age(9_999), "just now");
        assert_eq!(format_age(10_000), "10s ago");
        assert_eq!(format_age(59_000), "59s ago");
        assert_eq!(format_age(60_000), "1m ago");
        assert_eq!(format_age(59 * 60 * 1000), "59m ago");
        assert_eq!(format_age(60 * 60 * 1000), "1h ago");
        assert_eq!(format_age(23 * 3600 * 1000), "23h ago");
        assert_eq!(format_age(24 * 3600 * 1000), "1d ago");
        assert_eq!(format_age(4 * 24 * 3600 * 1000), "4d ago");
    }
}
