use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

/// Live view of the ntfy subscription.
///
/// The tray used to claim "HITL — Connected" unconditionally, from a string
/// baked in at startup. Since the client is otherwise silent — no console, and
/// until now no log — a dead subscription looked exactly like a healthy one.
///
/// Lives here rather than in the tray because the subscribe loop is what
/// actually knows the answer; the tray only renders it. Interior mutability via
/// atomics, because a host's state container only ever hands back `&Self`.
#[derive(Default)]
pub struct ConnectionStatus {
    connected: AtomicBool,
    /// Unix millis of the last ntfy event seen. 0 when there has not been one.
    last_message_ms: AtomicU64,
}

impl ConnectionStatus {
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

pub fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_786_543_402_123;

    #[test]
    fn status_says_disconnected_before_the_first_successful_subscribe() {
        // The old tray was a hardcoded "Connected" string, which is exactly
        // what made a dead subscription indistinguishable from a healthy one.
        let state = ConnectionStatus::default();
        assert_eq!(state.status_label(NOW), "HITL — Disconnected");
    }

    #[test]
    fn status_says_connected_before_any_message_has_arrived() {
        let state = ConnectionStatus::default();
        state.mark_connected(true);

        assert_eq!(state.status_label(NOW), "HITL — Connected");
    }

    #[test]
    fn status_reports_how_stale_the_connection_is() {
        let state = ConnectionStatus::default();
        state.mark_connected(true);
        state.last_message_ms.store(NOW - 7 * 60 * 1000, Ordering::Relaxed);

        assert_eq!(state.status_label(NOW), "HITL — Connected (last message 7m ago)");
    }

    #[test]
    fn losing_the_stream_overrides_a_recent_message() {
        let state = ConnectionStatus::default();
        state.mark_connected(true);
        state.mark_message();
        state.mark_connected(false);

        assert_eq!(state.status_label(NOW), "HITL — Disconnected");
    }

    #[test]
    fn age_never_reads_as_the_future_when_the_clock_moves_backwards() {
        // NTP correction or a suspend/resume can put `now` behind the stamp.
        let state = ConnectionStatus::default();
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
