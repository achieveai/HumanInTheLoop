//! Resolving a plan-review body for pane 3 (spec §8.3, §11).
//!
//! Two sources, and the difference matters:
//!
//! - **inline** — the bytes rode in the message. They are already in the log,
//!   so resolving one touches nothing outside this process.
//! - **attachment** — the bytes spilled to a ntfy attachment, which ntfy
//!   deletes after 3 hours. Past that window the archivist's capture is the
//!   only copy left anywhere, and `GET /bodies/{hash}` is the only way to it.
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

use hitl_store::Event;
use serde::Serialize;
use serde_json::Value;

use hitl_transport::payload::{decode_payload, PayloadError};
use hitl_transport::types::{PlanPayloadRef, PlanReviewBody};

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

/// Resolve one plan review's body, from wherever it actually lives.
pub async fn load(request: &Event, key: Option<&str>, base: &str) -> BodyOutcome {
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

    // `attachment`, and any spill kind a newer build invents: if it is not
    // inline the bytes are not here, and the archive is the only place to look.
    match fetch_captured(base, &reference.content_hash).await {
        Ok(plaintext) => decode(&plaintext, None, &reference.content_hash),
        Err(outcome) => outcome,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hitl_transport::payload::encode_payload;

    const KEY: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

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
        // The base is deliberately unroutable: if this ever starts reaching for
        // the network the test fails by timing out rather than passing quietly.
        let outcome = load(
            &event(r#"{"type":"plan_review","messageId":"p-1"}"#),
            None,
            "http://127.0.0.1:1",
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
            load(&request, Some(KEY), "http://127.0.0.1:1").await,
            BodyOutcome::Ok {
                content: plan().content,
                diff: plan().diff
            }
        );
    }

    #[tokio::test]
    async fn an_inline_reference_carrying_no_data_says_so_rather_than_fetching() {
        let outcome = load(
            &event(
                r#"{"type":"plan_review","messageId":"p-1",
                    "body":{"kind":"inline","contentHash":"ab"}}"#,
            ),
            None,
            "http://127.0.0.1:1",
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
            &event(
                r#"{"type":"plan_review","messageId":"p-1",
                    "body":{"kind":"attachment","contentHash":""}}"#,
            ),
            None,
            "http://127.0.0.1:1",
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
            &event(
                r#"{"type":"plan_review","messageId":"p-1",
                    "body":{"kind":"attachment","contentHash":"ab"}}"#,
            ),
            None,
            "http://127.0.0.1:1",
        )
        .await;

        match outcome {
            BodyOutcome::Unreachable { detail } => assert!(!detail.is_empty()),
            other => panic!("expected unreachable, got {other:?}"),
        }
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
