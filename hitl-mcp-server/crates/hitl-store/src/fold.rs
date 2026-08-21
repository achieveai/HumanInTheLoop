//! The fold: events in, status out. Pure.

use crate::events::Event;

/// The unified status vocabulary of spec §7.2, across all three message types.
///
/// `stale` is deliberately absent. It is `pending` plus the wall-clock age of
/// the owning session, and a clock is exactly what this module may not touch —
/// a fold that reads the time is a fold two devices can disagree about. It is
/// applied by the projection layer instead.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Pending,
    Answered,
    Skipped,
    Dismissed,
    Cancelled,
    Superseded,
    AgentGone,
    Lost,
}

impl Status {
    /// The wire/storage spelling from spec §7.2. The UI pill and the `messages`
    /// column both read this, so the two can never drift apart.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Answered => "answered",
            Self::Skipped => "skipped",
            Self::Dismissed => "dismissed",
            Self::Cancelled => "cancelled",
            Self::Superseded => "superseded",
            Self::AgentGone => "agent_gone",
            Self::Lost => "lost",
        }
    }
}

/// A plan review's outcome.
///
/// Local to this crate rather than to `hitl-transport`, where the wire field is
/// a `String` on purpose so that a verdict a newer peer invented cannot fail
/// the surrounding message's deserialization. That tolerance is preserved here:
/// an unrecognized verdict folds to `None`, never to an error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Approved,
    ChangesRequested,
    Rejected,
    Skipped,
    Cancelled,
}

impl Verdict {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "approved" => Some(Self::Approved),
            "changes_requested" => Some(Self::ChangesRequested),
            "rejected" => Some(Self::Rejected),
            "skipped" => Some(Self::Skipped),
            "cancelled" => Some(Self::Cancelled),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Approved => "approved",
            Self::ChangesRequested => "changes_requested",
            Self::Rejected => "rejected",
            Self::Skipped => "skipped",
            Self::Cancelled => "cancelled",
        }
    }
}

/// What the events say about one message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MessageState {
    pub status: Status,
    pub verdict: Option<Verdict>,
    /// Who closed it, and from which device. `None` while pending.
    pub responder: Option<String>,
    /// ntfy time of the settling event — never the payload's own `timestamp`,
    /// which is set by whichever machine composed the message.
    pub responded_at: Option<u64>,
}

impl Default for MessageState {
    fn default() -> Self {
        Self {
            status: Status::Pending,
            verdict: None,
            responder: None,
            responded_at: None,
        }
    }
}

/// Fold every event about one message into its current state.
///
/// Pure: the same slice always folds to the same state, in any order, on any
/// device, at any time. That property is the whole design — see the crate docs.
pub fn fold(events: &[Event]) -> MessageState {
    // Sort by ntfy's own ordering key, never by the caller's order and never by
    // the payload's `timestamp` — that field is written by whichever machine
    // composed the message, so a skewed or lying clock could otherwise win a
    // race it did not win (spec §4.3). `ntfy_id` breaks ties because ntfy's
    // time is only second-granular, and two responses inside one second is
    // exactly the race this has to resolve.
    let mut ordered: Vec<&Event> = events.iter().collect();
    ordered.sort_by(|a, b| (a.ntfy_time, &a.ntfy_id).cmp(&(b.ntfy_time, &b.ntfy_id)));

    let mut state = MessageState::default();
    let mut settled = false;

    for event in &ordered {
        // Spec §9.2: the winning response is the *first* settling event in
        // ntfy order. Everything after it is a loser, and a loser must never
        // overwrite the winner — including a `cancel_review`, which races a
        // human's response exactly the way a second device does. If the cancel
        // came first, the agent was already gone when the response was
        // published; if the response came first, the server consumed it before
        // deciding to cancel.
        if settled {
            continue;
        }

        match settle(event) {
            Some(settlement) => {
                state.status = settlement.status;
                state.verdict = settlement.verdict;
                state.responder = settlement.responder;
                state.responded_at = Some(event.ntfy_time);
                settled = true;
            }
            None => continue,
        }
    }

    // The server publishes this after reading the log, so it outranks anything
    // derived locally: it is the one participant that knows which response the
    // agent actually consumed. Applied as a set membership test rather than as
    // a step in the walk, so its effect cannot depend on where it lands.
    //
    // The ack names a `responseId`, and a stricter reading would flip to `lost`
    // only when that id is the response this fold picked as the winner. It is
    // not used that way here: a `lost` ack for a subject means some response to
    // it was discarded, and the pane needs to say so.
    if ordered.iter().any(is_lost_ack) {
        state.status = Status::Lost;
    }

    state
}

/// The settlement one event carries, or `None` if it settles nothing.
struct Settlement {
    status: Status,
    verdict: Option<Verdict>,
    responder: Option<String>,
}

fn settle(event: &Event) -> Option<Settlement> {
    match event.msg_type.as_str() {
        "answer" => {
            let skipped = event
                .json()
                .get("skipped")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            Some(Settlement {
                status: if skipped { Status::Skipped } else { Status::Answered },
                verdict: None,
                responder: event.field("respondedFrom"),
            })
        }

        "plan_review_response" => {
            let verdict = event.field("verdict").as_deref().and_then(Verdict::parse);
            Some(Settlement {
                // An unrecognized verdict from a newer peer still answered the
                // review — it just cannot be labelled. Reading it as anything
                // but `answered` would claim a human never replied.
                status: match verdict {
                    Some(Verdict::Skipped) => Status::Skipped,
                    Some(Verdict::Cancelled) => Status::Cancelled,
                    _ => Status::Answered,
                },
                verdict,
                responder: event.field("respondedFrom"),
            })
        }

        "dismiss_notification" => Some(Settlement {
            status: Status::Dismissed,
            verdict: None,
            responder: event.field("dismissedFrom"),
        }),

        "cancel_review" => Some(Settlement {
            status: match event.field("reason").as_deref() {
                Some("superseded") => Status::Superseded,
                Some("agent_exited") => Status::AgentGone,
                // `cancelled`, and anything a newer server invents: the review
                // is over and nobody is waiting on it. Which flavour of over is
                // a label, and guessing wrong there is cheaper than showing a
                // dead review as still needing an answer.
                _ => Status::Cancelled,
            },
            verdict: None,
            responder: None,
        }),

        // Requests, acks and decoration settle nothing. A request with no
        // response folds to the `Pending` default, which is what makes an
        // orphaned review read as pending rather than as quietly answered
        // (spec §16.5).
        _ => None,
    }
}

fn is_lost_ack(event: &&Event) -> bool {
    event.msg_type == "plan_review_ack" && event.field("status").as_deref() == Some("lost")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every helper builds an `Event` directly rather than going through a
    /// `Store`, because `fold` is defined over a slice and must not need one.
    /// The ntfy id is derived from the content so that a given event is the
    /// same event no matter which test builds it — otherwise the
    /// order-independence property would rest on an accident of insertion.
    fn event(ntfy_time: u64, subject: &str, msg_type: &str, payload: String) -> Event {
        Event {
            seq: 0,
            ntfy_id: format!("{msg_type}-{subject}-{ntfy_time}"),
            ntfy_time,
            message_id: format!("{msg_type}-{subject}-{ntfy_time}"),
            msg_type: msg_type.to_string(),
            subject_id: Some(subject.to_string()),
            payload,
        }
    }

    fn question(id: &str) -> Event {
        event(
            1,
            id,
            "question",
            format!(r#"{{"type":"question","messageId":"{id}","question":"Proceed?"}}"#),
        )
    }

    fn answer(subject: &str, responder: &str, skipped: bool) -> Event {
        answer_inner(subject, responder, skipped, 10)
    }

    fn answer_at(subject: &str, responder: &str, at: u64) -> Event {
        answer_inner(subject, responder, false, at)
    }

    fn answer_inner(subject: &str, responder: &str, skipped: bool, at: u64) -> Event {
        Event {
            ntfy_id: format!("answer-{subject}-{responder}-{at}"),
            ..event(
                at,
                subject,
                "answer",
                format!(
                    r#"{{"type":"answer","questionId":"{subject}","respondedFrom":"{responder}",
                        "selectedValues":["yes"],"skipped":{skipped}}}"#
                ),
            )
        }
    }

    fn notification(id: &str) -> Event {
        event(
            1,
            id,
            "notification",
            format!(r#"{{"type":"notification","messageId":"{id}","title":"t","body":"b"}}"#),
        )
    }

    fn dismiss(subject: &str) -> Event {
        event(
            10,
            subject,
            "dismiss_notification",
            format!(
                r#"{{"type":"dismiss_notification","notificationId":"{subject}",
                    "dismissedFrom":"phone"}}"#
            ),
        )
    }

    fn plan_review(id: &str) -> Event {
        event(
            1,
            id,
            "plan_review",
            format!(r#"{{"type":"plan_review","messageId":"{id}","displayPath":"docs/plan.md"}}"#),
        )
    }

    fn review_response(subject: &str, verdict: &str) -> Event {
        event(
            10,
            subject,
            "plan_review_response",
            format!(
                r#"{{"type":"plan_review_response","reviewId":"{subject}","verdict":"{verdict}",
                    "respondedFrom":"laptop"}}"#
            ),
        )
    }

    fn cancel(subject: &str, reason: &str) -> Event {
        event(
            10,
            subject,
            "cancel_review",
            format!(r#"{{"type":"cancel_review","reviewId":"{subject}","reason":"{reason}"}}"#),
        )
    }

    fn ack(subject: &str, status: &str) -> Event {
        event(
            20,
            subject,
            "plan_review_ack",
            format!(
                r#"{{"type":"plan_review_ack","reviewId":"{subject}","status":"{status}"}}"#
            ),
        )
    }

    #[test]
    fn a_question_with_no_answer_is_pending() {
        assert_eq!(fold(&[question("q-1")]).status, Status::Pending);
    }

    #[test]
    fn a_question_with_an_answer_is_answered() {
        let st = fold(&[question("q-1"), answer("q-1", "Kay9", false)]);
        assert_eq!(st.status, Status::Answered);
        assert_eq!(st.responder.as_deref(), Some("Kay9"));
    }

    #[test]
    fn a_skipped_answer_is_skipped_not_answered() {
        assert_eq!(
            fold(&[question("q-1"), answer("q-1", "Kay9", true)]).status,
            Status::Skipped
        );
    }

    #[test]
    fn the_first_response_in_ntfy_order_wins() {
        // Spec §9.2. Deliberately appended out of order to prove the fold sorts.
        let st = fold(&[
            question("q-1"),
            answer_at("q-1", "laptop", 200),
            answer_at("q-1", "phone", 100),
        ]);
        assert_eq!(st.responder.as_deref(), Some("phone"), "earlier ntfy order wins");
    }

    #[test]
    fn a_later_response_never_overwrites_the_winner() {
        let st = fold(&[
            question("q-1"),
            answer_at("q-1", "phone", 100),
            answer_at("q-1", "laptop", 200),
        ]);
        assert_eq!(st.responder.as_deref(), Some("phone"));
    }

    #[test]
    fn a_dismissed_notification_is_dismissed() {
        assert_eq!(
            fold(&[notification("n-1"), dismiss("n-1")]).status,
            Status::Dismissed
        );
    }

    #[test]
    fn a_plan_review_carries_its_verdict() {
        let st = fold(&[plan_review("p-1"), review_response("p-1", "approved")]);
        assert_eq!(st.status, Status::Answered);
        assert_eq!(st.verdict, Some(Verdict::Approved));
    }

    #[test]
    fn cancel_reasons_map_to_distinct_statuses() {
        assert_eq!(
            fold(&[plan_review("p"), cancel("p", "cancelled")]).status,
            Status::Cancelled
        );
        assert_eq!(
            fold(&[plan_review("p"), cancel("p", "superseded")]).status,
            Status::Superseded
        );
        assert_eq!(
            fold(&[plan_review("p"), cancel("p", "agent_exited")]).status,
            Status::AgentGone
        );
    }

    #[test]
    fn a_lost_ack_marks_this_devices_response_lost() {
        let st = fold(&[
            plan_review("p-1"),
            review_response("p-1", "approved"),
            ack("p-1", "lost"),
        ]);
        assert_eq!(st.status, Status::Lost);
    }

    #[test]
    fn folding_is_order_independent() {
        // The same event set in any permutation must fold to the same state.
        // This property is why two devices agree on a winner with no arbiter.
        let evs = vec![
            question("q-1"),
            answer_at("q-1", "phone", 100),
            answer_at("q-1", "laptop", 200),
        ];
        let forward = fold(&evs);
        let mut reversed = evs.clone();
        reversed.reverse();
        assert_eq!(forward, fold(&reversed));
    }

    #[test]
    fn every_permutation_of_a_contested_review_folds_the_same_way() {
        // The reversal above is one permutation out of 120. This is the same
        // property over all of them, on the hardest set: two racing responses,
        // a cancel, and a lost ack — every event kind whose handling could
        // plausibly depend on where in the walk it lands.
        let evs = vec![
            plan_review("p-1"),
            review_response("p-1", "approved"),
            Event {
                ntfy_id: "second-responder".to_string(),
                ntfy_time: 15,
                ..review_response("p-1", "rejected")
            },
            cancel("p-1", "agent_exited"),
            ack("p-1", "lost"),
        ];
        let expected = fold(&evs);

        for permutation in permutations(&evs) {
            assert_eq!(fold(&permutation), expected, "{:?}", ids(&permutation));
        }
    }

    fn ids(events: &[Event]) -> Vec<&str> {
        events.iter().map(|e| e.ntfy_id.as_str()).collect()
    }

    fn permutations(events: &[Event]) -> Vec<Vec<Event>> {
        if events.len() <= 1 {
            return vec![events.to_vec()];
        }
        let mut out = Vec::new();
        for (i, head) in events.iter().enumerate() {
            let mut rest = events.to_vec();
            rest.remove(i);
            for mut tail in permutations(&rest) {
                tail.insert(0, head.clone());
                out.push(tail);
            }
        }
        out
    }

    #[test]
    fn an_orphan_stays_pending_and_is_never_silently_answered() {
        // Spec §16.5 — a real incident. A review whose agent died reads pending,
        // even though a response was published, because no ack ever arrives.
        assert_eq!(fold(&[plan_review("p-1")]).status, Status::Pending);
    }
}
