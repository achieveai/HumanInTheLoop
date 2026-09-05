//! The property the whole no-arbiter design rests on (spec §9.2, plan Task 9).
//!
//! Two devices subscribed to the same ntfy topic do **not** receive events in
//! the same order. A phone that was asleep gets a burst on wake; a laptop that
//! never disconnected got them one at a time; a machine that started this
//! morning got its history from the archivist's backfill, which pages by local
//! ingest order and not by ntfy time. So the *insertion* order into each
//! device's `Store` genuinely differs, every time.
//!
//! If two `Store`s driven by the same event set in different insertion orders
//! could disagree about who won a race, the design would need an arbiter — a
//! service, a lock, a leader — and this whole architecture would be wrong.
//! `fold::tests::folding_is_order_independent` checks the pure function; this
//! checks the property survives the round trip through SQLite, which is what
//! every device actually does.

use hitl_store::{fold, MessageState, Store};
use hitl_transport::ntfy::subscribe::NtfyEvent;

/// One event as it arrives off the topic: ntfy's own id and time, plus the
/// decrypted body. Nothing here carries an insertion order — that is the point.
struct Wire {
    ntfy_id: &'static str,
    ntfy_time: u64,
    payload: String,
}

fn wire(ntfy_id: &'static str, ntfy_time: u64, payload: String) -> Wire {
    Wire { ntfy_id, ntfy_time, payload }
}

fn question(id: &str) -> String {
    format!(r#"{{"type":"question","messageId":"{id}","question":"Proceed?"}}"#)
}

fn answer(response_id: &str, subject: &str, from: &str) -> String {
    format!(
        r#"{{"type":"answer","messageId":"{response_id}","questionId":"{subject}",
             "respondedFrom":"{from}","selectedValues":["yes"],"skipped":false}}"#
    )
}

fn plan_review(id: &str) -> String {
    format!(r#"{{"type":"plan_review","messageId":"{id}","displayPath":"docs/plan.md"}}"#)
}

fn review_response(response_id: &str, subject: &str, verdict: &str, from: &str) -> String {
    format!(
        r#"{{"type":"plan_review_response","messageId":"{response_id}","reviewId":"{subject}",
             "verdict":"{verdict}","respondedFrom":"{from}"}}"#
    )
}

fn ack(subject: &str, response_id: &str, status: &str) -> String {
    format!(
        r#"{{"type":"plan_review_ack","messageId":"ack-{response_id}","reviewId":"{subject}",
             "responseId":"{response_id}","status":"{status}"}}"#
    )
}

fn cancel(subject: &str, reason: &str) -> String {
    format!(
        r#"{{"type":"cancel_review","messageId":"cancel-{subject}","reviewId":"{subject}",
             "reason":"{reason}"}}"#
    )
}

fn notification(id: &str) -> String {
    format!(r#"{{"type":"notification","messageId":"{id}","title":"t","body":"b"}}"#)
}

fn dismiss(response_id: &str, subject: &str, from: &str) -> String {
    format!(
        r#"{{"type":"dismiss_notification","messageId":"{response_id}",
             "notificationId":"{subject}","dismissedFrom":"{from}"}}"#
    )
}

fn restore(response_id: &str, subject: &str, dismissal_id: &str, from: &str) -> String {
    format!(
        r#"{{"type":"restore_notification","messageId":"{response_id}",
             "notificationId":"{subject}","dismissalId":"{dismissal_id}",
             "restoredFrom":"{from}"}}"#
    )
}

/// A device that ingested `log` in the order given.
fn device(log: &[&Wire]) -> Store {
    let store = Store::open_in_memory().expect("a store opens");
    for event in log {
        store
            .append(
                &NtfyEvent {
                    id: event.ntfy_id.to_string(),
                    time: event.ntfy_time,
                    ..Default::default()
                },
                &event.payload,
            )
            .expect("an event appends");
    }
    store
}

/// What one device believes about one message, read back out of its database.
fn belief(store: &Store, subject: &str) -> MessageState {
    fold(&store.events_for(subject).expect("the subject reads back"))
}

/// Every ordering two devices could plausibly disagree by: forwards, backwards,
/// and every rotation. Rotations are the realistic shape — a device that was
/// offline for a moment gets the tail first on reconnect, then the replayed
/// head.
fn orderings(log: &[Wire]) -> Vec<Vec<&Wire>> {
    let forward: Vec<&Wire> = log.iter().collect();
    let mut out = vec![forward.clone()];

    let mut backward = forward.clone();
    backward.reverse();
    out.push(backward);

    for split in 1..log.len() {
        let mut rotated: Vec<&Wire> = forward[split..].to_vec();
        rotated.extend_from_slice(&forward[..split]);
        out.push(rotated);
    }
    out
}

/// Drive one device per ordering and assert they all believe the same thing.
///
/// The *value* is asserted too, not just the agreement: two devices that agree
/// on the wrong winner agree just as loudly as two that agree on the right one.
fn agree_on(log: Vec<Wire>, subject: &str, expected: &MessageState) {
    let orders = orderings(&log);
    assert!(orders.len() >= 3, "the case must have enough events to reorder");

    for (n, order) in orders.iter().enumerate() {
        let ids: Vec<&str> = order.iter().map(|e| e.ntfy_id).collect();
        let got = belief(&device(order), subject);
        assert_eq!(&got, expected, "device {n} ingested {ids:?} and disagreed");
    }
}

#[test]
fn two_devices_agree_on_who_answered_a_contested_question() {
    // The §9.2 race with no ack of any kind — the case the whole fold-only path
    // exists for. The phone's answer is earlier in ntfy order, so the phone wins
    // on both devices, however either of them happened to receive the two.
    agree_on(
        vec![
            wire("ntfy-1", 100, question("q-1")),
            wire("ntfy-2", 200, answer("resp-phone", "q-1", "phone")),
            wire("ntfy-3", 201, answer("resp-laptop", "q-1", "laptop")),
        ],
        "q-1",
        &MessageState {
            status: hitl_store::Status::Answered,
            verdict: None,
            responder: Some("phone".to_string()),
            responded_at: Some(200),
            response_id: Some("resp-phone".to_string()),
        },
    );
}

#[test]
fn two_devices_agree_when_the_race_is_decided_inside_one_second() {
    // ntfy's time is second-granular, so the realistic race is a tie on time
    // broken by ntfy's id. If the tie-break depended on insertion order the two
    // devices would each declare *themselves* the winner — which is the exact
    // failure mode a no-arbiter design cannot survive.
    agree_on(
        vec![
            wire("ntfy-1", 100, question("q-1")),
            wire("ntfy-aaa", 200, answer("resp-A", "q-1", "phone")),
            wire("ntfy-bbb", 200, answer("resp-B", "q-1", "laptop")),
        ],
        "q-1",
        &MessageState {
            status: hitl_store::Status::Answered,
            verdict: None,
            responder: Some("phone".to_string()),
            responded_at: Some(200),
            response_id: Some("resp-A".to_string()),
        },
    );
}

#[test]
fn two_devices_agree_on_a_contested_review_the_agent_never_read() {
    // Two responses and an ack naming the winner as lost. Both devices must
    // read `lost` — including the one whose own response won the ntfy race,
    // because winning the race is not the same as the agent having consumed it.
    agree_on(
        vec![
            wire("ntfy-1", 100, plan_review("p-1")),
            wire("ntfy-2", 200, review_response("resp-A", "p-1", "approved", "phone")),
            wire("ntfy-3", 210, review_response("resp-B", "p-1", "rejected", "laptop")),
            wire("ntfy-4", 220, ack("p-1", "resp-A", "lost")),
        ],
        "p-1",
        &MessageState {
            status: hitl_store::Status::Lost,
            verdict: Some(hitl_store::Verdict::Approved),
            responder: Some("phone".to_string()),
            responded_at: Some(200),
            response_id: Some("resp-A".to_string()),
        },
    );
}

#[test]
fn two_devices_agree_when_an_ack_names_the_response_that_lost() {
    // The ack the *losing* device receives. It is on the shared topic, so both
    // devices see it — and neither may let it mark the message lost, or every
    // contested review in the Inbox would read `lost` on the device that
    // actually answered it.
    agree_on(
        vec![
            wire("ntfy-1", 100, plan_review("p-1")),
            wire("ntfy-2", 200, review_response("resp-A", "p-1", "approved", "phone")),
            wire("ntfy-3", 210, review_response("resp-B", "p-1", "rejected", "laptop")),
            wire("ntfy-4", 220, ack("p-1", "resp-B", "lost")),
        ],
        "p-1",
        &MessageState {
            status: hitl_store::Status::Answered,
            verdict: Some(hitl_store::Verdict::Approved),
            responder: Some("phone".to_string()),
            responded_at: Some(200),
            response_id: Some("resp-A".to_string()),
        },
    );
}

#[test]
fn two_devices_agree_when_a_response_races_a_cancel() {
    // A `cancel_review` races a human exactly the way a second device does, and
    // gets no special case: here it is earlier, so nobody replied in time and
    // both devices say the agent was already gone. `response_id` stays `None`,
    // so the laptop that published `resp-A` correctly reads "not mine, and not
    // anybody's" rather than believing it won.
    agree_on(
        vec![
            wire("ntfy-1", 100, plan_review("p-1")),
            wire("ntfy-2", 200, cancel("p-1", "agent_exited")),
            wire("ntfy-3", 300, review_response("resp-A", "p-1", "approved", "laptop")),
            wire("ntfy-4", 320, ack("p-1", "resp-A", "lost")),
        ],
        "p-1",
        &MessageState {
            status: hitl_store::Status::AgentGone,
            verdict: None,
            responder: None,
            responded_at: Some(200),
            response_id: None,
        },
    );
}

#[test]
fn two_devices_agree_on_who_dismissed_a_notification() {
    agree_on(
        vec![
            wire("ntfy-1", 100, notification("n-1")),
            wire("ntfy-2", 200, dismiss("resp-phone", "n-1", "phone")),
            wire("ntfy-3", 260, dismiss("resp-laptop", "n-1", "laptop")),
        ],
        "n-1",
        &MessageState {
            status: hitl_store::Status::Dismissed,
            verdict: None,
            responder: Some("phone".to_string()),
            responded_at: Some(200),
            response_id: Some("resp-phone".to_string()),
        },
    );
}

#[test]
fn two_devices_agree_that_a_targeted_restore_returns_a_notification_to_pending() {
    agree_on(
        vec![
            wire("ntfy-1", 100, notification("n-1")),
            wire(
                "ntfy-restore",
                150,
                restore("restore-1", "n-1", "dismiss-phone", "laptop"),
            ),
            wire("ntfy-dismiss", 200, dismiss("dismiss-phone", "n-1", "phone")),
        ],
        "n-1",
        &MessageState::default(),
    );
}

#[test]
fn two_devices_agree_that_an_untargeted_dismissal_still_owns_the_notification() {
    agree_on(
        vec![
            wire("ntfy-1", 100, notification("n-1")),
            wire("ntfy-2", 200, dismiss("dismiss-phone", "n-1", "phone")),
            wire("ntfy-3", 210, dismiss("dismiss-laptop", "n-1", "laptop")),
            wire(
                "ntfy-4",
                220,
                restore("restore-1", "n-1", "dismiss-phone", "desktop"),
            ),
        ],
        "n-1",
        &MessageState {
            status: hitl_store::Status::Dismissed,
            verdict: None,
            responder: Some("laptop".to_string()),
            responded_at: Some(210),
            response_id: Some("dismiss-laptop".to_string()),
        },
    );
}

#[test]
fn two_devices_agree_that_an_orphan_is_still_waiting() {
    // Spec §16.5. Nothing settled it, so it reads `pending` on every device no
    // matter what else is in the log around it — never quietly answered.
    agree_on(
        vec![
            wire("ntfy-1", 100, plan_review("p-1")),
            wire("ntfy-2", 110, question("q-1")),
            wire("ntfy-3", 120, answer("resp-A", "q-1", "phone")),
        ],
        "p-1",
        &MessageState::default(),
    );
}

#[test]
fn a_replayed_event_cannot_change_a_devices_mind() {
    // ntfy replays its whole cache window on reconnect, so a device sees the
    // same event many times. `append` is idempotent on `ntfy_id`; if it were
    // not, a duplicate response would be a second settling event and the fold
    // would be walking a log that never happened.
    let log = vec![
        wire("ntfy-1", 100, question("q-1")),
        wire("ntfy-2", 200, answer("resp-phone", "q-1", "phone")),
        wire("ntfy-3", 201, answer("resp-laptop", "q-1", "laptop")),
    ];
    let once: Vec<&Wire> = log.iter().collect();
    let mut replayed = once.clone();
    replayed.extend(once.iter().copied());
    replayed.extend(once.iter().copied());

    assert_eq!(belief(&device(&once), "q-1"), belief(&device(&replayed), "q-1"));
    assert_eq!(device(&replayed).count_events().unwrap(), 3);
}
