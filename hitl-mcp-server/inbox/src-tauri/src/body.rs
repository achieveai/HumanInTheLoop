//! Resolving a plan-review body for pane 3 (spec §8.3, §11).
//!
//! Three sources, tried in that order, and the differences matter:
//!
//! - **inline** — the bytes rode in the message. They are already in the log,
//!   so resolving one touches nothing outside this process.
//! - **our own capture** — the bytes spilled to a ntfy attachment and
//!   [`crate::capture`] pulled them down at ingest, while the URL was still
//!   alive. Also nothing outside this process, which is the whole point: spec
//!   §11 requires every client to work with the archivist stopped, and before
//!   this existed an attachment-backed plan read as "could not fetch" the
//!   moment that daemon was not running.
//! - **the archivist** — for bodies this Inbox never captured: messages that
//!   predate the capture path, or that arrived while the window was closed.
//!   Past ntfy's 3 h attachment window its copy is the only one left anywhere,
//!   and `GET /bodies/{hash}` is the only way to it.
//!
//! # This never runs on the paint path
//!
//! Nothing here is called while pane 2 is drawing. `list_messages` is a pure
//! function of `(events, now)` and must stay one: putting a round trip on the
//! paint path would make the message list render differently depending on
//! whether a separate process happened to be running, which is exactly the
//! dependency spec §11 forbids. A body is fetched when a message is
//! *selected*, and never before.
//!
//! # Every failure is its own failure
//!
//! `BodyOutcome` deliberately does not collapse. "Gone" is unrecoverable and
//! "undecryptable" is one config line from being readable; reporting the second
//! as the first sends someone hunting a problem that does not exist. An
//! archivist that is not running is a fourth thing again — it is allowed to be
//! down, so that state is not an error at all, and the Inbox says so rather
//! than implying the plan is lost.
//!
//! A body still downloading is the fifth, and the reason it exists is a real
//! hour lost: with no way to tell "not captured" from "not captured *yet*",
//! resolution fell through to the archivist and printed *start it and reopen
//! this message*. Somebody did, it did not help, and the actual state — bytes
//! arriving in a few seconds — stayed hidden behind that advice. A body on its
//! way must never blame a daemon, so [`crate::capture::Pending`] is consulted
//! before the archivist is.

use hitl_store::{BodyStatus, Event};
use serde::Serialize;
use serde_json::Value;

use hitl_transport::payload::{decode_payload, PayloadError};
use hitl_transport::types::{PlanPayloadRef, PlanReviewBody};

use crate::capture::Pending;
use crate::sink::SharedStore;

/// How long to wait on the archivist. Loopback, so a slow answer means the
/// process is wedged rather than that the network is far away; the Inbox would
/// rather say "not reachable" than leave pane 3 spinning.
const FETCH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// What resolving one plan body produced.
///
/// A closed vocabulary the UI branches on. `detail` strings are prose for a
/// human and must never be parsed — the same rule the archivist states about
/// its own `detail` field.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "outcome", rename_all = "camelCase")]
pub enum BodyOutcome {
    /// Decoded, and its hash matched what the message claimed.
    Ok { content: String, diff: String },

    /// The bytes arrived and are **not** the plan the message describes.
    ///
    /// Renders read-only with a warning rather than showing the content. A plan
    /// we cannot vouch for is worse than no plan: approving the wrong bytes is
    /// the failure the whole review feature exists to prevent.
    #[serde(rename_all = "camelCase")]
    HashMismatch { expected: String, actual: String },

    /// The archivist answered, and has no usable copy. `status` is its own
    /// `BodyStatus` vocabulary — `gone` / `undecryptable` / `corrupt` /
    /// `unattempted` / `unknown` — passed through rather than folded down.
    #[serde(rename_all = "camelCase")]
    Missing {
        status: String,
        detail: Option<String>,
        /// Only on `unknown`: the raw reason a newer build wrote.
        reason: Option<String>,
    },

    /// Nothing answered on loopback. **Not an error**: spec §11 requires every
    /// client to work with the archivist stopped.
    #[serde(rename_all = "camelCase")]
    Unreachable { detail: String },

    /// This Inbox is downloading the bytes right now.
    ///
    /// Distinct from every neighbour above on purpose. It is not `Missing`,
    /// because nothing has failed and nothing is lost; and it is emphatically
    /// not `Unreachable`, because that panel tells the reader to go start the
    /// archivist — advice that is useless here, since the daemon has no part in
    /// this fetch and starting it changes nothing. Sending someone to fix a
    /// working component is how a five-second wait turns into an hour of
    /// hunting.
    Fetching,

    /// The archivist answered, and could not read its own archive.
    #[serde(rename_all = "camelCase")]
    Unreadable { detail: String },

    /// The bytes are in hand and this build could not turn them into a plan.
    /// `kind` is `decrypt` / `corrupt` / `too_large`, matching the vocabulary
    /// `ReviewBodyError::kind` already hands the client's review window.
    #[serde(rename_all = "camelCase")]
    Undecodable { kind: String, detail: String },

    /// The message references no body at all.
    Absent,
}

/// The body reference a request event carries, if any.
pub fn body_ref(request: &Event) -> Option<PlanPayloadRef> {
    let body: Value = request.json().get("body")?.clone();
    serde_json::from_value(body).ok()
}

/// Percent-encode one path segment.
///
/// `contentHash` arrives off the wire, so it is attacker-influenced text being
/// pasted into a URL path. Today's hashes are hex and encode to themselves, but
/// nothing in the type says so, and a hash of `../events` would otherwise walk
/// the archivist's router. Everything outside the unreserved set is escaped.
pub fn encode_segment(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for byte in raw.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Turn a payload plaintext (or an encrypted envelope, given a key) into a body.
///
/// The hash verification spec §8.3 requires happens inside `decode_payload`,
/// before decompression — so a truncated or substituted body surfaces as a
/// refusal rather than as a half-rendered plan.
pub fn decode(cipher: &str, key: Option<&str>, expected_hash: &str) -> BodyOutcome {
    match decode_payload::<PlanReviewBody>(cipher.trim(), key, expected_hash) {
        Ok(body) => BodyOutcome::Ok {
            content: body.content,
            diff: body.diff,
        },
        Err(PayloadError::HashMismatch { expected, actual }) => {
            BodyOutcome::HashMismatch { expected, actual }
        }
        Err(e) => BodyOutcome::Undecodable {
            kind: decode_kind(&e).to_string(),
            detail: e.to_string(),
        },
    }
}

/// The vocabulary the client's review window already branches on, so both apps
/// name the same failure the same way.
fn decode_kind(error: &PayloadError) -> &'static str {
    match error {
        PayloadError::Decrypt(_) => "decrypt",
        PayloadError::TooLarge { .. } => "too_large",
        PayloadError::MissingData | PayloadError::Expired => "missing",
        _ => "corrupt",
    }
}

/// Read a 404's `BodyStatus` JSON into an outcome.
///
/// An unparseable 404 becomes `unknown` rather than `gone`: the archivist did
/// answer, so the body may well be recoverable, and declaring it dead on a
/// parse failure would be a guess dressed up as a fact.
pub fn parse_missing(body: &str) -> BodyOutcome {
    let json: Value = match serde_json::from_str(body) {
        Ok(json) => json,
        Err(_) => {
            return BodyOutcome::Missing {
                status: "unknown".to_string(),
                detail: Some("the archivist's answer could not be read".to_string()),
                reason: Some("unparseable".to_string()),
            }
        }
    };

    let field = |key: &str| {
        json.get(key)
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };

    BodyOutcome::Missing {
        status: field("status").unwrap_or_else(|| "unknown".to_string()),
        detail: field("detail"),
        reason: field("reason"),
    }
}

/// Ask the archivist for the bytes it captured under `content_hash`.
///
/// `Ok` carries the payload plaintext — the archivist stores what it decrypted
/// and verified, never the ciphertext, so nothing here needs a key.
pub async fn fetch_captured(base: &str, content_hash: &str) -> Result<String, BodyOutcome> {
    let url = format!("{base}/bodies/{}", encode_segment(content_hash));
    let response = reqwest::Client::new()
        .get(&url)
        .timeout(FETCH_TIMEOUT)
        .send()
        .await
        .map_err(|e| BodyOutcome::Unreachable {
            detail: format!("{e}"),
        })?;

    let status = response.status();
    let text = response.text().await.unwrap_or_default();

    if status.is_success() {
        return Ok(text);
    }
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err(parse_missing(&text));
    }
    Err(BodyOutcome::Unreadable {
        detail: format!("the archivist answered {status}"),
    })
}

/// What this Inbox's own capture left behind for one hash.
enum Local {
    /// The captured bytes. Holding them under the claimed hash *is* the proof
    /// they were verified against it — nothing else is ever written there.
    Held(Vec<u8>),
    /// We reached for this body and it will never arrive. Kept as an outcome
    /// rather than a status so the vocabulary the UI branches on stays one.
    Failed(BodyOutcome),
    /// Nothing captured, and nothing that failed. The archivist may still have
    /// it — this Inbox may simply never have seen the message arrive.
    Nothing,
}

/// Ask the local store, under one lock and without touching the network.
///
/// One call rather than `get_body` then `body_status`, for the reason the
/// archivist gives about its own pair: between two calls a fetch can land, and
/// the pair can then report "missing" and explain that the body is verified —
/// a state that never existed.
fn local(store: &SharedStore, content_hash: &str) -> Local {
    let guard = store.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

    match guard.get_body(content_hash) {
        Ok(Some(bytes)) => return Local::Held(bytes),
        Ok(None) => {}
        Err(e) => {
            // A broken database is not a missing body, and must not be reported
            // as one. Fall through to the archivist and let it answer.
            log::warn!("could not read the captured body for {content_hash}: {e}");
            return Local::Nothing;
        }
    }

    match guard.body_status(content_hash) {
        // `Gone` / `Undecryptable` / `Corrupt` / `Unknown` stay four separate
        // facts, in the same vocabulary the archivist's own 404 uses, so a
        // local answer and a remote one render identically.
        Ok(BodyStatus::Gone { detail, .. }) => Local::Failed(missing("gone", detail, None)),
        Ok(BodyStatus::Undecryptable { detail, .. }) => {
            Local::Failed(missing("undecryptable", detail, None))
        }
        Ok(BodyStatus::Corrupt { detail, .. }) => Local::Failed(missing("corrupt", detail, None)),
        Ok(BodyStatus::Unknown { reason, detail, .. }) => {
            Local::Failed(missing("unknown", detail, Some(reason)))
        }
        // `Unattempted` is not a failure — it is a body still on its way, or one
        // this Inbox never saw. `Verified` cannot happen: the bytes would have
        // come back above, under the same lock.
        Ok(_) => Local::Nothing,
        Err(e) => {
            log::warn!("could not read the body status for {content_hash}: {e}");
            Local::Nothing
        }
    }
}

fn missing(status: &str, detail: Option<String>, reason: Option<String>) -> BodyOutcome {
    BodyOutcome::Missing {
        status: status.to_string(),
        detail,
        reason,
    }
}

/// Resolve one plan review's body, from wherever it actually lives.
pub async fn load(
    store: &SharedStore,
    pending: &Pending,
    request: &Event,
    key: Option<&str>,
    base: &str,
) -> BodyOutcome {
    let Some(reference) = body_ref(request) else {
        return BodyOutcome::Absent;
    };
    if reference.content_hash.is_empty() {
        // The hash *is* the identity: with none there is nothing to verify
        // against and nothing the archivist could be asked for.
        return BodyOutcome::Undecodable {
            kind: "corrupt".to_string(),
            detail: "the plan reference carries no contentHash to verify against".to_string(),
        };
    }

    if reference.kind == "inline" {
        return match reference.data.as_deref() {
            Some(data) => decode(data, key, &reference.content_hash),
            None => BodyOutcome::Undecodable {
                kind: "missing".to_string(),
                detail: "the plan said its body was inline and carried none".to_string(),
            },
        };
    }

    // `attachment`, and any spill kind a newer build invents: the bytes did not
    // ride in the message, so they are either in our own capture or nowhere
    // this process can reach without help.
    //
    // The lock is taken and dropped inside `local`, before anything is awaited.
    let captured = local(store, &reference.content_hash);
    if let Local::Held(bytes) = captured {
        return match String::from_utf8(bytes) {
            // Stored decrypted, as the exact preimage of the hash it is keyed
            // by, so no key is needed to read it back — and `decode` still
            // verifies, because a body nothing re-checked is a body nothing can
            // vouch for.
            Ok(plaintext) => decode(&plaintext, None, &reference.content_hash),
            Err(_) => BodyOutcome::Undecodable {
                kind: "corrupt".to_string(),
                detail: "the captured plan body is not the text it was stored as".to_string(),
            },
        };
    }

    // Between "nothing captured" and "nothing captured *yet*" the store cannot
    // tell the difference — both are the same absent row — so the in-flight set
    // is asked, and it is asked here rather than after the archivist because
    // the archivist has no answer that is more true than this one.
    //
    // Only when `local` found nothing at all. A recorded verdict outranks a
    // download: a body already known to be gone or corrupt must keep saying so
    // even while a doomed retry is in the air.
    if matches!(captured, Local::Nothing) && pending.contains(&reference.content_hash) {
        return BodyOutcome::Fetching;
    }

    match fetch_captured(base, &reference.content_hash).await {
        Ok(plaintext) => decode(&plaintext, None, &reference.content_hash),
        // The archivist is allowed to be down (spec §11). When it is, anything
        // we found out ourselves beats "not reachable" — telling someone to
        // start a daemon that cannot help is worse than telling them the plan
        // expired.
        Err(BodyOutcome::Unreachable { detail }) => match captured {
            Local::Failed(outcome) => outcome,
            _ => BodyOutcome::Unreachable { detail },
        },
        // Anything else means the archivist answered, and it knows more about
        // its own archive than our failure row does about ours.
        Err(outcome) => outcome,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::{Arc, Mutex};

    use hitl_store::Store;
    use hitl_transport::payload::encode_payload;

    const KEY: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

    /// Deliberately unroutable. Every test below points at it, so a path that
    /// starts reaching for the archivist fails loudly instead of quietly
    /// passing against the one that happens to be running on this machine.
    const NO_ARCHIVIST: &str = "http://127.0.0.1:1";

    fn store() -> SharedStore {
        Arc::new(Mutex::new(Store::open_in_memory().expect("opens")))
    }

    /// Nothing downloading. The default for every test that is not about the
    /// in-flight set, so `Fetching` can never be the reason one of them passes.
    fn idle() -> Pending {
        Pending::default()
    }

    /// A body this Inbox has a fetch out for right now.
    fn fetching(hash: &str) -> Pending {
        let pending = Pending::default();
        pending.mark(hash);
        pending
    }

    fn event(payload: &str) -> Event {
        Event {
            seq: 0,
            ntfy_id: "ntfy-1".to_string(),
            ntfy_time: 100,
            message_id: "p-1".to_string(),
            msg_type: "plan_review".to_string(),
            subject_id: Some("p-1".to_string()),
            payload: payload.to_string(),
        }
    }

    fn plan() -> PlanReviewBody {
        PlanReviewBody {
            content: "# Plan\n\nstep one\n".to_string(),
            diff: "@@ -0,0 +1 @@\n+step one\n".to_string(),
        }
    }

    // --- decoding ---

    #[test]
    fn a_verified_body_decodes_to_its_content_and_diff() {
        let encoded = encode_payload(&plan(), Some(KEY)).expect("encodes");
        let outcome = decode(
            encoded.cipher.as_str(),
            Some(KEY),
            &encoded.payload_ref.content_hash,
        );

        assert_eq!(
            outcome,
            BodyOutcome::Ok {
                content: plan().content,
                diff: plan().diff,
            }
        );
    }

    #[test]
    fn a_body_that_is_not_what_the_message_claimed_is_a_hash_mismatch() {
        // Spec §8.3's central rule: the content is never shown on a mismatch,
        // so the outcome has to be distinguishable from every other failure.
        let encoded = encode_payload(&plan(), Some(KEY)).expect("encodes");
        let claimed = "0".repeat(64);

        match decode(encoded.cipher.as_str(), Some(KEY), &claimed) {
            BodyOutcome::HashMismatch { expected, actual } => {
                assert_eq!(expected, claimed);
                assert_eq!(actual, encoded.payload_ref.content_hash);
                assert_ne!(actual, expected);
            }
            other => panic!("expected a hash mismatch, got {other:?}"),
        }
    }

    #[test]
    fn a_body_encrypted_with_a_key_this_device_lacks_is_a_decrypt_failure() {
        // Not `corrupt`, and emphatically not `gone`: the bytes are fine and
        // the reader is one config line away from them.
        let encoded = encode_payload(&plan(), Some(KEY)).expect("encodes");

        match decode(
            encoded.cipher.as_str(),
            None,
            &encoded.payload_ref.content_hash,
        ) {
            // Read as plaintext, the envelope hashes to something else, so the
            // hash check fires first. Either way it must not read as `ok`.
            BodyOutcome::HashMismatch { .. } => {}
            BodyOutcome::Undecodable { kind, .. } => assert_eq!(kind, "decrypt"),
            other => panic!("a body we cannot read must not decode: {other:?}"),
        }
    }

    #[test]
    fn a_wrong_key_is_reported_as_a_decrypt_failure_not_as_corruption() {
        let other_key = "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100";
        let encoded = encode_payload(&plan(), Some(KEY)).expect("encodes");

        match decode(
            encoded.cipher.as_str(),
            Some(other_key),
            &encoded.payload_ref.content_hash,
        ) {
            BodyOutcome::Undecodable { kind, .. } => assert_eq!(kind, "decrypt"),
            other => panic!("expected a decrypt failure, got {other:?}"),
        }
    }

    #[test]
    fn garbage_bytes_are_corrupt() {
        match decode("not a payload at all", None, &"a".repeat(64)) {
            // The hash is checked before anything is decompressed, so garbage
            // is caught there first. That is the correct order.
            BodyOutcome::HashMismatch { .. } => {}
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    // --- the reference on the message ---

    #[test]
    fn an_inline_reference_is_read_off_the_event() {
        let reference = body_ref(&event(
            r#"{"type":"plan_review","messageId":"p-1",
                "body":{"kind":"inline","data":"x","contentHash":"ab","contentLength":1}}"#,
        ))
        .expect("a body reference");

        assert_eq!(reference.kind, "inline");
        assert_eq!(reference.data.as_deref(), Some("x"));
        assert_eq!(reference.content_hash, "ab");
    }

    #[test]
    fn a_message_with_no_body_has_no_reference() {
        assert!(body_ref(&event(r#"{"type":"plan_review","messageId":"p-1"}"#)).is_none());
    }

    #[tokio::test]
    async fn a_message_with_no_body_resolves_to_absent_without_a_round_trip() {
        let outcome = load(
            &store(),
            &idle(),
            &event(r#"{"type":"plan_review","messageId":"p-1"}"#),
            None,
            NO_ARCHIVIST,
        )
        .await;

        assert_eq!(outcome, BodyOutcome::Absent);
    }

    #[tokio::test]
    async fn an_inline_body_is_resolved_without_touching_the_archivist() {
        // Rule 1 of the task and spec §11 both: an inline body is already in
        // hand, and asking a process that may not be running for bytes we hold
        // would make the Inbox depend on it for no reason.
        let encoded = encode_payload(&plan(), Some(KEY)).expect("encodes");
        let request = event(&format!(
            r#"{{"type":"plan_review","messageId":"p-1","body":{}}}"#,
            serde_json::to_string(&encoded.payload_ref).expect("serializes")
        ));

        assert_eq!(
            load(&store(), &idle(), &request, Some(KEY), NO_ARCHIVIST).await,
            BodyOutcome::Ok {
                content: plan().content,
                diff: plan().diff
            }
        );
    }

    #[tokio::test]
    async fn an_inline_reference_carrying_no_data_says_so_rather_than_fetching() {
        let outcome = load(
            &store(),
            &idle(),
            &event(
                r#"{"type":"plan_review","messageId":"p-1",
                    "body":{"kind":"inline","contentHash":"ab"}}"#,
            ),
            None,
            NO_ARCHIVIST,
        )
        .await;

        assert_eq!(
            outcome,
            BodyOutcome::Undecodable {
                kind: "missing".to_string(),
                detail: "the plan said its body was inline and carried none".to_string(),
            }
        );
    }

    #[tokio::test]
    async fn a_reference_with_no_hash_is_refused_rather_than_requested() {
        // An empty hash would be asked of the archivist and 404 forever.
        let outcome = load(
            &store(),
            &idle(),
            &event(
                r#"{"type":"plan_review","messageId":"p-1",
                    "body":{"kind":"attachment","contentHash":""}}"#,
            ),
            None,
            NO_ARCHIVIST,
        )
        .await;

        match outcome {
            BodyOutcome::Undecodable { kind, .. } => assert_eq!(kind, "corrupt"),
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn an_archivist_that_is_not_running_is_its_own_state() {
        // Spec §11: every client works when the archivist is down. That is not
        // a plan that is gone, corrupt or undecryptable, and must not read as
        // one — port 1 on loopback refuses the connection immediately.
        let outcome = load(
            &store(),
            &idle(),
            &event(
                r#"{"type":"plan_review","messageId":"p-1",
                    "body":{"kind":"attachment","contentHash":"ab"}}"#,
            ),
            None,
            NO_ARCHIVIST,
        )
        .await;

        match outcome {
            BodyOutcome::Unreachable { detail } => assert!(!detail.is_empty()),
            other => panic!("expected unreachable, got {other:?}"),
        }
    }

    // --- our own capture, with nothing else running ---

    /// A plan review whose body spilled to a ntfy attachment, plus the cipher
    /// that came down the wire for it.
    fn spilled_review(key: Option<&str>) -> (String, Event) {
        let encoded = encode_payload(&plan(), key).expect("encodes");
        let mut body_ref = encoded.payload_ref;
        body_ref.kind = "attachment".to_string();
        body_ref.data = None;

        let request = event(&format!(
            r#"{{"type":"plan_review","messageId":"p-1","body":{}}}"#,
            serde_json::to_string(&body_ref).expect("serializes")
        ));
        (encoded.cipher, request)
    }

    /// What `crate::capture` does when the fetch comes back, without the fetch.
    fn capture(store: &SharedStore, claimed_hash: &str, cipher: &str, key: Option<&str>) {
        let guard = store.lock().expect("locks");
        guard.capture_body(claimed_hash, cipher, key, Some("ntfy-1"));
    }

    fn claimed_hash(request: &Event) -> String {
        body_ref(request).expect("a body reference").content_hash
    }

    #[tokio::test]
    async fn an_attachment_captured_at_ingest_is_readable_with_no_archivist_running() {
        // The defect, in one test. The bytes were on ntfy when the message
        // arrived and this Inbox pulled them down then; spec §11 says the plan
        // must still render with the archivist stopped. Before the capture
        // path this was `unreachable` — "could not fetch the plan" — for a plan
        // sitting in our own database.
        let store = store();
        let (cipher, request) = spilled_review(None);
        capture(&store, &claimed_hash(&request), &cipher, None);

        assert_eq!(
            load(&store, &idle(), &request, None, NO_ARCHIVIST).await,
            BodyOutcome::Ok {
                content: plan().content,
                diff: plan().diff,
            }
        );
    }

    #[tokio::test]
    async fn an_encrypted_attachment_reads_back_without_the_key_it_arrived_under() {
        // What is captured is the payload plaintext — the exact preimage of
        // `contentHash` — so reading it back needs no key at all. Storing the
        // wire ciphertext instead would key the table by a hash of something it
        // does not contain, and this would fail as a mismatch.
        let store = store();
        let (cipher, request) = spilled_review(Some(KEY));
        capture(&store, &claimed_hash(&request), &cipher, Some(KEY));

        assert_eq!(
            load(&store, &idle(), &request, None, NO_ARCHIVIST).await,
            BodyOutcome::Ok {
                content: plan().content,
                diff: plan().diff,
            }
        );
    }

    #[tokio::test]
    async fn bytes_that_fail_the_hash_check_never_become_a_readable_plan() {
        // Spec §8.3's central rule, on the capture path. The bytes are real and
        // decode perfectly; they are simply not the plan this message
        // describes, and approving the wrong plan is the failure the whole
        // review feature exists to prevent. Nothing may be stored under the
        // claimed hash, so the claimed hash must still miss afterwards.
        let store = store();
        let (cipher, _) = spilled_review(None);
        let claimed = "0".repeat(64);
        let request = event(&format!(
            r#"{{"type":"plan_review","messageId":"p-1",
                 "body":{{"kind":"attachment","contentHash":"{claimed}"}}}}"#
        ));
        capture(&store, &claimed, &cipher, None);

        let outcome = load(&store, &idle(), &request, None, NO_ARCHIVIST).await;

        assert_eq!(
            outcome,
            BodyOutcome::Missing {
                status: "corrupt".to_string(),
                detail: Some(format!(
                    "claimed {claimed}, {} bytes hash to {}",
                    cipher.len(),
                    hitl_transport::payload::sha256_hex(&cipher)
                )),
                reason: None,
            },
            "a body we cannot vouch for must never render as content"
        );
        assert!(!store.lock().expect("locks").has_body(&claimed).expect("reads"));
    }

    #[tokio::test]
    async fn a_local_capture_that_gave_up_beats_saying_the_archivist_is_down() {
        // `gone` and `unreachable` send a reader to opposite places: one says
        // the plan is unrecoverable, the other says start a daemon. With the
        // archivist stopped and our own row saying the attachment expired,
        // "start the archivist" would be advice that cannot possibly help.
        let store = store();
        let (_, request) = spilled_review(None);
        crate::capture::note_gone(
            &store,
            &claimed_hash(&request),
            "ntfy-1",
            "ntfy dropped the attachment",
        );

        assert_eq!(
            load(&store, &idle(), &request, None, NO_ARCHIVIST).await,
            BodyOutcome::Missing {
                status: "gone".to_string(),
                detail: Some("ntfy dropped the attachment".to_string()),
                reason: None,
            }
        );
    }

    #[tokio::test]
    async fn a_body_we_never_reached_for_still_reads_as_the_archivist_being_down() {
        // The other half, and the reason `Unattempted` is not a failure: a
        // message that arrived while this Inbox was closed has no local row at
        // all, and the archivist genuinely is the place to look. Reporting our
        // silence as a verdict would declare a live plan dead.
        let store = store();
        let (_, request) = spilled_review(None);

        match load(&store, &idle(), &request, None, NO_ARCHIVIST).await {
            BodyOutcome::Unreachable { detail } => assert!(!detail.is_empty()),
            other => panic!("expected unreachable, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn the_local_copy_is_preferred_even_when_an_archivist_would_answer() {
        // An archivist may well be running on this machine — one is, on the
        // developer box this was written on. A local hit must short-circuit it
        // anyway, or the Inbox keeps the dependency the capture was added to
        // remove. The port here is not one anything answers on.
        let store = store();
        let (cipher, request) = spilled_review(None);
        capture(&store, &claimed_hash(&request), &cipher, None);

        assert!(matches!(
            load(&store, &idle(), &request, None, "http://127.0.0.1:1").await,
            BodyOutcome::Ok { .. }
        ));
    }

    // --- a body that is merely late ---

    #[tokio::test]
    async fn a_body_still_downloading_says_so_instead_of_blaming_the_archivist() {
        // The bug this exists for. The store cannot tell "never captured" from
        // "not captured yet" — both are the same absent row — so before the
        // in-flight set this fell through and printed "start the archivist".
        // Somebody did. It could not help, and it hid the real state for an
        // hour. The pair below is the whole point: identical stores, and the
        // one difference is whether a fetch is out.
        let store = store();
        let (_, request) = spilled_review(None);

        assert_eq!(
            load(
                &store,
                &fetching(&claimed_hash(&request)),
                &request,
                None,
                NO_ARCHIVIST
            )
            .await,
            BodyOutcome::Fetching,
        );
        assert!(
            matches!(
                load(&store, &idle(), &request, None, NO_ARCHIVIST).await,
                BodyOutcome::Unreachable { .. }
            ),
            "and with nothing in flight the archivist is still the place to look"
        );
    }

    #[tokio::test]
    async fn a_recorded_verdict_outranks_a_download_still_in_the_air() {
        // A retry can be queued for a body already known to be lost. If
        // "downloading" spoke first, `gone` would be replaced by an invitation
        // to wait — and the waiting would never end.
        let store = store();
        let (_, request) = spilled_review(None);
        let hash = claimed_hash(&request);
        crate::capture::note_gone(&store, &hash, "ntfy-1", "ntfy dropped the attachment");

        assert_eq!(
            load(&store, &fetching(&hash), &request, None, NO_ARCHIVIST).await,
            BodyOutcome::Missing {
                status: "gone".to_string(),
                detail: Some("ntfy dropped the attachment".to_string()),
                reason: None,
            }
        );
    }

    #[tokio::test]
    async fn a_body_already_captured_is_shown_rather_than_reported_as_arriving() {
        // The set is in memory and the store is not, so a stale claim can
        // outlive the bytes it was made for. Content wins over any claim.
        let store = store();
        let (cipher, request) = spilled_review(None);
        let hash = claimed_hash(&request);
        capture(&store, &hash, &cipher, None);

        assert!(matches!(
            load(&store, &fetching(&hash), &request, None, NO_ARCHIVIST).await,
            BodyOutcome::Ok { .. }
        ));
    }

    // --- the archivist's 404 vocabulary ---

    #[test]
    fn gone_and_undecryptable_stay_different_facts() {
        // The single most important distinction in this module. One is
        // unrecoverable; the other is a missing config line.
        assert_eq!(
            parse_missing(r#"{"contentHash":"ab","status":"gone","detail":"ntfy 404","at":1}"#),
            BodyOutcome::Missing {
                status: "gone".to_string(),
                detail: Some("ntfy 404".to_string()),
                reason: None,
            }
        );
        assert_eq!(
            parse_missing(r#"{"contentHash":"ab","status":"undecryptable","detail":"no key"}"#),
            BodyOutcome::Missing {
                status: "undecryptable".to_string(),
                detail: Some("no key".to_string()),
                reason: None,
            }
        );
    }

    #[test]
    fn an_unknown_reason_is_carried_through_rather_than_flattened() {
        // A reason written by a newer build. Forcing it onto `gone` would
        // declare a recoverable body dead.
        assert_eq!(
            parse_missing(r#"{"status":"unknown","reason":"quarantined","detail":"see log"}"#),
            BodyOutcome::Missing {
                status: "unknown".to_string(),
                detail: Some("see log".to_string()),
                reason: Some("quarantined".to_string()),
            }
        );
    }

    #[test]
    fn corrupt_and_unattempted_come_back_as_themselves() {
        assert_eq!(
            parse_missing(r#"{"status":"corrupt","actualHash":"cd"}"#),
            BodyOutcome::Missing {
                status: "corrupt".to_string(),
                detail: None,
                reason: None,
            }
        );
        assert_eq!(
            parse_missing(r#"{"status":"unattempted"}"#),
            BodyOutcome::Missing {
                status: "unattempted".to_string(),
                detail: None,
                reason: None,
            }
        );
    }

    #[test]
    fn an_unreadable_answer_is_unknown_rather_than_gone() {
        match parse_missing("<html>proxy error</html>") {
            BodyOutcome::Missing { status, reason, .. } => {
                assert_eq!(status, "unknown");
                assert_eq!(reason.as_deref(), Some("unparseable"));
            }
            other => panic!("expected missing/unknown, got {other:?}"),
        }
    }

    // --- url safety ---

    #[test]
    fn a_hex_hash_encodes_to_itself() {
        let hash = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
        assert_eq!(encode_segment(hash), hash);
    }

    #[test]
    fn a_hash_that_tries_to_walk_the_router_is_escaped() {
        // `contentHash` is attacker-influenced text going into a URL path.
        assert_eq!(encode_segment("../events"), "..%2Fevents");
        assert_eq!(encode_segment("sha256:ab"), "sha256%3Aab");
        assert!(!encode_segment("a?b#c").contains('?'));
    }

    // --- the serialized shape the webview reads ---

    #[test]
    fn every_outcome_is_a_tagged_camel_case_object() {
        // The renderer branches on `outcome`, and nothing in JS fails loudly
        // when a tag is renamed — the pane just draws a blank panel.
        let tag = |outcome: BodyOutcome| {
            serde_json::to_value(outcome).unwrap()["outcome"]
                .as_str()
                .unwrap()
                .to_string()
        };

        assert_eq!(
            tag(BodyOutcome::Ok {
                content: String::new(),
                diff: String::new()
            }),
            "ok"
        );
        assert_eq!(
            tag(BodyOutcome::HashMismatch {
                expected: String::new(),
                actual: String::new()
            }),
            "hashMismatch"
        );
        assert_eq!(
            tag(BodyOutcome::Missing {
                status: "gone".into(),
                detail: None,
                reason: None
            }),
            "missing"
        );
        assert_eq!(
            tag(BodyOutcome::Unreachable {
                detail: String::new()
            }),
            "unreachable"
        );
        assert_eq!(
            tag(BodyOutcome::Unreadable {
                detail: String::new()
            }),
            "unreadable"
        );
        assert_eq!(
            tag(BodyOutcome::Undecodable {
                kind: "corrupt".into(),
                detail: String::new()
            }),
            "undecodable"
        );
        assert_eq!(tag(BodyOutcome::Absent), "absent");
    }
}
