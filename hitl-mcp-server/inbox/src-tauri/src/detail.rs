//! Pane 3 — one message, whole (spec §8).
//!
//! Pane 2's [`MessageRow`] is a header and nothing else: no body, no options,
//! no comment thread. Pane 3 needs all of that, so this module hands back the
//! request event's payload verbatim alongside the row.
//!
//! **Verbatim is the point.** Nothing here reshapes a payload into a
//! renderer-specific struct. The three renderers read the same field names the
//! MCP server published — `question`, `options`, `allowMultiple`, `body`,
//! `displayPath` — which is what lets `client/src/review.js` be reused by the
//! Inbox unchanged: it is already written against exactly that shape. A
//! translation layer here would be a second place for the wire format to be
//! described, and the two would drift.
//!
//! The row still comes from [`crate::view::build_list`] rather than being
//! recomputed, so the status pill in pane 3 cannot disagree with the one in
//! pane 2 — including the `stale` overlay, which needs the whole log to decide.

use hitl_store::Event;
use serde::Serialize;
use serde_json::Value;

use crate::identity;
use crate::view::{self, MessageRow};

/// Who sent this, and how confident the attribution is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SenderBadge {
    pub label: String,
    /// `session` | `worktree` | `path`, or absent on an older publisher.
    pub source: Option<String>,
}

/// What `get_message()` returns.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageDetail {
    /// The same header pane 2 drew, so the two panes cannot disagree.
    pub row: MessageRow,
    /// The request event's payload, exactly as it was published.
    pub request: Value,
    /// The payload of the event that settled it, or `null` while pending.
    ///
    /// This is the *winning* settlement of spec §9.2 — the first settling event
    /// in ntfy order — so the answered form shows what the agent actually
    /// received, not whatever a losing device published afterwards.
    pub settlement: Option<Value>,
    pub sender: Option<SenderBadge>,
}

/// The event types that settle a message.
///
/// Mirrors the arms of `hitl_store::fold`'s private `settle`. Kept in step by
/// [`tests::the_settlement_the_detail_picks_is_the_one_the_fold_folded`], which
/// fails if the two ever disagree about which event closed a message.
fn settles(msg_type: &str) -> bool {
    matches!(
        msg_type,
        "answer" | "plan_review_response" | "dismiss_notification" | "cancel_review"
    )
}

/// The request event a subject is about.
fn request_event(events: &[Event]) -> Option<&Event> {
    events
        .iter()
        .find(|e| matches!(e.msg_type.as_str(), "question" | "notification" | "plan_review"))
}

/// The settlement selected by the already-folded row.
///
/// Response-bearing settlements are correlated by their exact `messageId` so
/// a tombstoned dismissal can never leak into detail. Server cancellations do
/// not carry a response ID; preserve their existing detail by selecting the
/// cancel only when the folded row reports a terminal review-cancel status.
fn folded_settlement<'a>(events: &'a [Event], row: &MessageRow) -> Option<&'a Event> {
    if let Some(response_id) = row.response_id.as_deref() {
        return events
            .iter()
            .find(|event| event.message_id == response_id && settles(&event.msg_type));
    }

    if row.msg_type != "plan_review"
        || !matches!(
            row.status.as_str(),
            "cancelled" | "superseded" | "agent_gone"
        )
    {
        return None;
    }

    events
        .iter()
        .filter(|event| event.msg_type == "cancel_review")
        .min_by(|a, b| (a.ntfy_time, &a.ntfy_id).cmp(&(b.ntfy_time, &b.ntfy_id)))
}

/// Every event about one subject.
fn events_for(events: &[Event], message_id: &str) -> Vec<Event> {
    events
        .iter()
        .filter(|e| e.subject_id.as_deref() == Some(message_id))
        .cloned()
        .collect()
}

/// Build pane 3's view of one message (spec §8).
///
/// `None` when the id names nothing the Inbox can show — including a subject
/// whose request event has scrolled out of ntfy's window, which pane 2 also
/// refuses to draw a row for.
pub fn build_detail(events: &[Event], message_id: &str, now: u64) -> Option<MessageDetail> {
    let subject = events_for(events, message_id);
    let request = request_event(&subject)?;

    // Taken from the list rather than rebuilt: `stale` is decided over the
    // owning session's whole history, so a row computed from this subject alone
    // would quietly disagree with the one pane 2 is showing.
    let row = view::build_list(events, None, Some("all"), now)
        .messages
        .into_iter()
        .find(|row| row.message_id == message_id)?;
    let settlement = folded_settlement(&subject, &row).map(|event| event.json());

    Some(MessageDetail {
        row,
        request: request.json(),
        settlement,
        sender: identity::sender_info(&subject).map(|(label, source)| SenderBadge { label, source }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_786_600_000;
    const MINUTE: u64 = 60;

    fn ev(ntfy_id: &str, time: u64, payload: &str) -> Event {
        let json: Value = serde_json::from_str(payload).expect("test payload must be json");
        let msg_type = json
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        Event {
            seq: 0,
            ntfy_id: ntfy_id.to_string(),
            ntfy_time: time,
            message_id: json
                .get("messageId")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
            subject_id: hitl_store::events::subject_of(&msg_type, &json),
            msg_type,
            payload: payload.to_string(),
        }
    }

    fn question() -> Event {
        ev(
            "ntfy-q1",
            NOW - 2 * MINUTE,
            r#"{"type":"question","messageId":"q-1","question":"Which backend?",
                "context":"Picking storage","allowMultiple":false,"allowOther":true,
                "options":[{"label":"SQLite","value":"sqlite"},{"label":"Files","value":"files"}]}"#,
        )
    }

    fn notification() -> Event {
        ev(
            "ntfy-n1",
            NOW - 3 * MINUTE,
            r#"{"type":"notification","messageId":"n-1","title":"Done","body":"Finished"}"#,
        )
    }

    fn detail(events: &[Event], id: &str) -> MessageDetail {
        build_detail(events, id, NOW).unwrap_or_else(|| panic!("no detail for {id}"))
    }

    #[test]
    fn the_request_payload_comes_back_verbatim() {
        // The three renderers read the published field names directly. A
        // reshaping layer here would be a second description of the wire
        // format, and review.js is already written against the first.
        let d = detail(&[question()], "q-1");

        assert_eq!(d.request["question"], "Which backend?");
        assert_eq!(d.request["allowOther"], true);
        assert_eq!(d.request["options"][0]["value"], "sqlite");
        assert_eq!(d.request["context"], "Picking storage");
    }

    #[test]
    fn the_row_is_the_same_header_pane_two_drew() {
        let d = detail(&[question()], "q-1");
        let row = &view::build_list(&[question()], None, Some("all"), NOW).messages[0];

        assert_eq!(&d.row, row);
    }

    #[test]
    fn a_pending_message_has_no_settlement() {
        assert_eq!(detail(&[question()], "q-1").settlement, None);
    }

    #[test]
    fn an_answered_question_carries_what_was_actually_chosen() {
        // The answered form of spec §8.2 shows the selection locked and the
        // free text verbatim, which needs the answer payload, not just a pill.
        let events = [
            question(),
            ev(
                "ntfy-a1",
                NOW - MINUTE,
                r#"{"type":"answer","messageId":"a-1","questionId":"q-1","skipped":false,
                    "selectedValues":["sqlite"],"otherText":"but check the WAL story",
                    "respondedFrom":"Kay9 laptop"}"#,
            ),
        ];

        let d = detail(&events, "q-1");
        let settlement = d.settlement.expect("an answer settled it");
        assert_eq!(settlement["selectedValues"][0], "sqlite");
        assert_eq!(settlement["otherText"], "but check the WAL story");
        assert_eq!(d.row.status, "answered");
        assert_eq!(d.row.responder.as_deref(), Some("Kay9 laptop"));
    }

    #[test]
    fn the_settlement_the_detail_picks_is_the_one_the_fold_folded() {
        // The coupling this module has to `fold`'s private `settle`. If the two
        // ever pick different events, pane 3 shows one device's answer under
        // another device's name.
        let events = [
            question(),
            ev(
                "ntfy-a-late",
                NOW - MINUTE,
                r#"{"type":"answer","messageId":"a-2","questionId":"q-1","skipped":false,
                    "selectedValues":["files"],"respondedFrom":"laptop"}"#,
            ),
            ev(
                "ntfy-a-early",
                NOW - 90,
                r#"{"type":"answer","messageId":"a-1","questionId":"q-1","skipped":false,
                    "selectedValues":["sqlite"],"respondedFrom":"phone"}"#,
            ),
        ];

        let d = detail(&events, "q-1");
        let settlement = d.settlement.expect("settled");
        assert_eq!(settlement["respondedFrom"], "phone", "earlier in ntfy order wins");
        assert_eq!(settlement["selectedValues"][0], "sqlite");
        assert_eq!(d.row.responder.as_deref(), Some("phone"));
        assert_eq!(
            d.row.responded_at,
            Some(NOW - 90),
            "the fold and the detail must name the same settling event"
        );
    }

    #[test]
    fn notification_detail_uses_the_untombstoned_dismissal_named_by_the_fold() {
        let events = [
            notification(),
            ev(
                "ntfy-dismiss-a",
                NOW - 2 * MINUTE,
                r#"{"type":"dismiss_notification","messageId":"dismiss-a",
                    "notificationId":"n-1","dismissedFrom":"phone"}"#,
            ),
            ev(
                "ntfy-dismiss-b",
                NOW - MINUTE,
                r#"{"type":"dismiss_notification","messageId":"dismiss-b",
                    "notificationId":"n-1","dismissedFrom":"laptop"}"#,
            ),
            ev(
                "ntfy-restore-a",
                NOW,
                r#"{"type":"restore_notification","messageId":"restore-a",
                    "notificationId":"n-1","dismissalId":"dismiss-a","restoredFrom":"desktop"}"#,
            ),
        ];

        let d = detail(&events, "n-1");
        assert_eq!(d.row.response_id.as_deref(), Some("dismiss-b"));
        assert_eq!(
            d.settlement.as_ref().and_then(|value| value["messageId"].as_str()),
            Some("dismiss-b")
        );
        assert_eq!(
            d.settlement.expect("dismissal B remains")["dismissedFrom"],
            "laptop"
        );
    }

    #[test]
    fn restored_notification_detail_has_no_settlement() {
        let events = [
            notification(),
            ev(
                "ntfy-dismiss-a",
                NOW - MINUTE,
                r#"{"type":"dismiss_notification","messageId":"dismiss-a",
                    "notificationId":"n-1","dismissedFrom":"phone"}"#,
            ),
            ev(
                "ntfy-restore-a",
                NOW,
                r#"{"type":"restore_notification","messageId":"restore-a",
                    "notificationId":"n-1","dismissalId":"dismiss-a","restoredFrom":"laptop"}"#,
            ),
        ];

        let d = detail(&events, "n-1");
        assert_eq!(d.row.status, "pending");
        assert_eq!(d.row.responder, None);
        assert_eq!(d.row.responded_at, None);
        assert_eq!(d.row.response_id, None);
        assert_eq!(d.settlement, None);
    }

    #[test]
    fn a_cancelled_review_reports_the_cancel_as_its_settlement() {
        let events = [
            ev(
                "ntfy-p1",
                NOW - 2 * MINUTE,
                r#"{"type":"plan_review","messageId":"p-1","displayPath":"docs/p.md"}"#,
            ),
            ev(
                "ntfy-c1",
                NOW - MINUTE,
                r#"{"type":"cancel_review","messageId":"c-1","reviewId":"p-1",
                    "reason":"agent_exited"}"#,
            ),
        ];

        let d = detail(&events, "p-1");
        assert_eq!(d.row.status, "agent_gone");
        assert_eq!(d.settlement.expect("a cancel settled it")["reason"], "agent_exited");
    }

    #[test]
    fn the_sender_badge_carries_the_tier_it_was_resolved_at() {
        let events = [
            question(),
            ev(
                "ntfy-q1-ident",
                NOW - 2 * MINUTE,
                r#"{"type":"sender_identity","messageId":"s-1","forMessageId":"q-1",
                    "forType":"question","sender":{"label":"Hitl_MCP · master · a3f2",
                    "source":"session"}}"#,
            ),
        ];

        assert_eq!(
            detail(&events, "q-1").sender,
            Some(SenderBadge {
                label: "Hitl_MCP · master · a3f2".to_string(),
                source: Some("session".to_string()),
            })
        );
    }

    #[test]
    fn a_message_whose_identity_has_not_joined_yet_still_renders() {
        // Spec §5.5: no badge is the ordinary early state of every question,
        // not a reason to refuse the message.
        let d = detail(&[question()], "q-1");
        assert_eq!(d.sender, None);
        assert!(d.row.unattributed);
    }

    #[test]
    fn an_unknown_message_id_has_no_detail() {
        assert!(build_detail(&[question()], "nope", NOW).is_none());
    }

    #[test]
    fn a_settlement_whose_request_never_arrived_has_no_detail() {
        // Same rule pane 2 applies: ntfy's window can slide past a question and
        // leave its answer behind, and there is nothing truthful to render.
        let orphan = ev(
            "ntfy-a1",
            NOW,
            r#"{"type":"answer","messageId":"a-1","questionId":"gone","skipped":false,
                "selectedValues":["x"],"respondedFrom":"phone"}"#,
        );

        assert!(build_detail(&[orphan], "gone", NOW).is_none());
    }

    #[test]
    fn events_about_another_message_do_not_leak_in() {
        let events = [
            question(),
            ev(
                "ntfy-q2",
                NOW - MINUTE,
                r#"{"type":"question","messageId":"q-2","question":"Other?"}"#,
            ),
            ev(
                "ntfy-a2",
                NOW,
                r#"{"type":"answer","messageId":"a-2","questionId":"q-2","skipped":false,
                    "selectedValues":["y"],"respondedFrom":"phone"}"#,
            ),
        ];

        assert_eq!(detail(&events, "q-1").settlement, None);
        assert_eq!(detail(&events, "q-1").request["question"], "Which backend?");
    }

    #[test]
    fn the_json_the_detail_pane_receives_is_camel_case_and_complete() {
        // Same guard as `view::tests::the_json_the_panes_receive_...`: a serde
        // rename here reads as `undefined` in JS and draws an empty pane rather
        // than failing.
        let events = [
            question(),
            ev(
                "ntfy-q1-ident",
                NOW - 2 * MINUTE,
                r#"{"type":"sender_identity","messageId":"s-1","forMessageId":"q-1",
                    "forType":"question","sender":{"label":"L","source":"session"}}"#,
            ),
        ];
        let json = serde_json::to_value(detail(&events, "q-1")).unwrap();

        let mut keys: Vec<&str> = json.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort();
        assert_eq!(keys, ["request", "row", "sender", "settlement"]);

        let mut sender: Vec<&str> = json["sender"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        sender.sort();
        assert_eq!(sender, ["label", "source"]);
    }
}
