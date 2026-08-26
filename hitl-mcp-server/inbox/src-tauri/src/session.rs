//! Session state — spec §6.1, and the one place `stale` exists.
//!
//! `hitl_store::fold` deliberately has no `stale`, because deciding it needs a
//! wall clock and a fold that reads the time is a fold two devices can
//! disagree about. `stale` is therefore an overlay applied *here*, in the
//! projection layer, over a `pending` the fold produced. Everything in this
//! module is a pure function of its arguments — the clock is read once, at the
//! edge, and passed in.

/// An event this recent means the agent is doing something (spec §6.1).
pub const ACTIVE_WINDOW_SECS: u64 = 5 * 60;

/// Nothing heard for this long and the session has decayed (spec §6.1).
///
/// A decay heuristic, never a fact: a Claude Code session that exits cleanly
/// with nothing pending emits no signal at all, so the Inbox cannot know a
/// session ended. Sessions are never auto-deleted on the strength of this.
pub const STALE_WINDOW_SECS: u64 = 24 * 60 * 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionState {
    /// ● Something is blocking an agent and it is waiting on you.
    Waiting,
    /// ◐ Recent activity, nothing pending.
    Active,
    /// ○ Quiet.
    Idle,
    /// ○ dim — nothing heard in a day.
    Stale,
}

impl SessionState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Waiting => "waiting",
            Self::Active => "active",
            Self::Idle => "idle",
            Self::Stale => "stale",
        }
    }

    /// The glyph spec §6.1 pins for each state. Emitted from Rust rather than
    /// chosen in CSS so the pane and the tests read the same source.
    pub fn glyph(self) -> &'static str {
        match self {
            Self::Waiting => "●",
            Self::Active => "◐",
            Self::Idle | Self::Stale => "○",
        }
    }
}

/// Spec §6.1, as a pure function of the only two things it may depend on.
///
/// `pending_count` counts **blocking** pending messages only — questions and
/// plan reviews. A notification nobody has dismissed does not make a session
/// `waiting`; §6.1 says "blocks the agent", and nothing is blocked on a
/// notification.
///
/// **`stale` outranks `waiting`, deliberately.** The obvious reading of §6.1's
/// table is top-to-bottom, which would make `waiting` win — but then a session
/// holding one pending message could never decay, message status `stale`
/// ("`pending`, but session `stale`", §7.2) would be unreachable, and §7.2's
/// own note that an aborted question "stays `pending` until it decays to
/// `stale`" would be false. A day of silence is also the strongest evidence
/// the Inbox can have that the thing waiting on you is an orphan (§16.5), and
/// that is exactly when it must stop looking like live work.
pub fn session_state(pending_count: u32, last_event_age_secs: u64) -> SessionState {
    if last_event_age_secs >= STALE_WINDOW_SECS {
        return SessionState::Stale;
    }
    if pending_count > 0 {
        return SessionState::Waiting;
    }
    if last_event_age_secs < ACTIVE_WINDOW_SECS {
        return SessionState::Active;
    }
    SessionState::Idle
}

/// The status a row shows, once the session's decay is taken into account.
///
/// The only status the projection layer is allowed to add to the fold's
/// vocabulary, and the only place it is added.
pub fn display_status(folded: &str, state: SessionState) -> &str {
    if folded == "pending" && state == SessionState::Stale {
        "stale"
    } else {
        folded
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINUTE: u64 = 60;
    const HOUR: u64 = 60 * 60;

    #[test]
    fn a_blocking_pending_message_makes_a_session_waiting() {
        assert_eq!(session_state(1, 0), SessionState::Waiting);
        assert_eq!(session_state(3, 30 * MINUTE), SessionState::Waiting);
    }

    #[test]
    fn recent_activity_with_nothing_pending_is_active() {
        assert_eq!(session_state(0, 0), SessionState::Active);
        assert_eq!(session_state(0, 4 * MINUTE), SessionState::Active);
    }

    #[test]
    fn the_active_window_closes_at_five_minutes() {
        assert_eq!(session_state(0, ACTIVE_WINDOW_SECS - 1), SessionState::Active);
        assert_eq!(session_state(0, ACTIVE_WINDOW_SECS), SessionState::Idle);
    }

    #[test]
    fn quiet_for_more_than_five_minutes_is_idle() {
        assert_eq!(session_state(0, 6 * MINUTE), SessionState::Idle);
        assert_eq!(session_state(0, 23 * HOUR), SessionState::Idle);
    }

    #[test]
    fn the_stale_window_closes_at_twenty_four_hours() {
        assert_eq!(session_state(0, STALE_WINDOW_SECS - 1), SessionState::Idle);
        assert_eq!(session_state(0, STALE_WINDOW_SECS), SessionState::Stale);
    }

    #[test]
    fn a_day_of_silence_outranks_a_pending_message() {
        // The precedence argued for in the doc comment. If this ever flips,
        // `stale` becomes unreachable for any session that has work waiting —
        // which is every session the status was invented for.
        assert_eq!(session_state(1, STALE_WINDOW_SECS), SessionState::Stale);
        assert_eq!(session_state(9, 7 * 24 * HOUR), SessionState::Stale);
    }

    #[test]
    fn every_state_is_reachable() {
        // Guards the precedence above from the other direction: a rule set in
        // which one arm can never fire is a rule set with a dead branch.
        let observed = [
            session_state(1, 0),
            session_state(0, 0),
            session_state(0, HOUR),
            session_state(0, 48 * HOUR),
        ];
        assert_eq!(
            observed,
            [
                SessionState::Waiting,
                SessionState::Active,
                SessionState::Idle,
                SessionState::Stale
            ]
        );
    }

    #[test]
    fn a_session_with_no_events_at_all_is_not_reported_active() {
        // The projection passes a huge age for "never heard from", which has to
        // land on `stale` rather than accidentally reading as fresh.
        assert_eq!(session_state(0, u64::MAX), SessionState::Stale);
    }

    #[test]
    fn stale_only_overlays_a_pending_status() {
        assert_eq!(display_status("pending", SessionState::Stale), "stale");
        assert_eq!(display_status("pending", SessionState::Waiting), "pending");

        // A settled message stays settled no matter how long ago it happened.
        // Re-labelling an answered question `stale` would erase the one fact
        // the fold is certain about.
        for settled in ["answered", "skipped", "dismissed", "cancelled", "lost"] {
            assert_eq!(display_status(settled, SessionState::Stale), settled);
        }
    }
}
