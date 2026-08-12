use serde::{Deserialize, Serialize};

/// A selectable option presented to the human.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DialogOption {
    pub label: String,
    /// Agents often call the tool the way they call the built-in
    /// AskUserQuestion (which has no `value` field), so options can arrive with
    /// this key omitted entirely. Tolerate that instead of failing the whole
    /// message's deserialization silently (which drops the popup). The frontend
    /// falls back to `label` when `value` is empty.
    #[serde(default)]
    pub value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
}

/// A single question within a batch ask_question call.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubQuestion {
    /// Older/unpatched servers can publish a sub-question with this key
    /// omitted entirely — tolerate that instead of failing the whole
    /// message's deserialization silently.
    #[serde(default)]
    pub question: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub header: Option<String>,
    pub options: Vec<DialogOption>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_multiple: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_other: Option<bool>,
}

/// Answer to a single sub-question within a batch response.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubAnswer {
    pub question_index: usize,
    pub question_text: String,
    pub selected_values: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub other_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped: Option<bool>,
    pub response_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_preview: Option<String>,
}

/// Git repository context.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoContext {
    pub name: String,
    pub branch: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_url: Option<String>,
}

/// Question message published by MCP server.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionMessage {
    #[serde(rename = "type")]
    pub msg_type: String,
    pub message_id: String,
    pub timestamp: u64,
    pub repo: Option<RepoContext>,
    pub context: String,
    pub question: String,
    pub options: Vec<DialogOption>,
    pub allow_multiple: bool,
    pub allow_other: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout: Option<u64>,
    /// Batch questions — when present, question/options at top level are ignored
    #[serde(skip_serializing_if = "Option::is_none")]
    pub questions: Option<Vec<SubQuestion>>,
}

/// Answer message published by a client.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnswerMessage {
    #[serde(rename = "type")]
    pub msg_type: String,
    pub message_id: String,
    pub question_id: String,
    pub timestamp: u64,
    pub responded_from: String,
    pub selected_values: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub other_text: Option<String>,
    pub skipped: bool,
    /// Per-question answers for batch questions
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sub_answers: Option<Vec<SubAnswer>>,
}



/// Notification message published by MCP server (fire-and-forget).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationMessage {
    #[serde(rename = "type")]
    pub msg_type: String,
    pub message_id: String,
    pub timestamp: u64,
    pub title: String,
    pub body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
}

/// Dismiss notification message published by a client.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DismissNotificationMessage {
    #[serde(rename = "type")]
    pub msg_type: String,
    pub message_id: String,
    pub timestamp: u64,
    pub notification_id: String,
    pub dismissed_from: String,
}

/// A fragment of an oversized message body, published as its own ntfy message.
/// Transport-only wrapper — never survives past reassembly on the receiving side.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkMessage {
    #[serde(rename = "type")]
    pub msg_type: String,
    pub message_id: String,
    pub timestamp: u64,
    pub group_id: String,
    pub index: usize,
    pub total: usize,
    pub data: String,
}

// -----------------------------------------------------------
// Plan review (protocolVersion 2)
//
// These four message types are the ONLY ones that carry `protocolVersion`,
// gzip their body, and may spill to an ntfy attachment. They never chunk.
// The types above keep their exact pre-existing wire format — a new server
// must never break an already-installed client.
//
// Every non-discriminant field below is `#[serde(default)]` deliberately.
// The client has already shipped three tolerance fixes (2.9.2, 2.9.5, 2.9.6)
// for messages that omitted a field the struct declared as required; each one
// failed the whole message's deserialization and silently dropped the popup.
// These types start tolerant rather than earning it one incident at a time.
// For the same reason `verdict`, `reason` and `side` are `String`, not enums:
// an unrecognized value must not fail the surrounding message.
// -----------------------------------------------------------

/// The highest wire-shape version this client understands. A message declaring
/// a higher `protocolVersion` must surface an upgrade prompt, not be dropped.
pub const SUPPORTED_PROTOCOL_VERSION: u32 = 2;

/// Type-agnostic view of any message on the topic.
///
/// Parsed first so dispatch can branch on `type` and reject an unknown or
/// too-new message explicitly. The previous chain of `if let Ok(ConcreteType)`
/// attempts had no terminal branch, so anything it could not parse vanished
/// with no window and no log.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)] // contract surface; consumed by the review lanes
pub struct MessageEnvelope {
    #[serde(rename = "type")]
    pub msg_type: String,
    #[serde(default)]
    pub message_id: String,
    #[serde(default)]
    pub timestamp: u64,
    /// Absent ⇒ 1. Only the plan-review types emit it.
    #[serde(default)]
    pub protocol_version: Option<u32>,
}

impl MessageEnvelope {
    /// Wire-shape version, treating an absent field as the pre-versioning shape.
    pub fn version(&self) -> u32 {
        self.protocol_version.unwrap_or(1)
    }
}

/// ntfy-event-level attachment metadata, parsed off the raw ntfy JSON event.
///
/// Never carried inside our own message — the URL only exists after the PUT.
/// This is plaintext metadata outside our encryption, which is why senders must
/// put random hex in the `Filename` header and never a real path.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)] // contract surface; consumed by the review lanes
pub struct AttachmentRef {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub url: String,
    #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    /// Unix seconds. ntfy expires attachments after 3 h but messages after 12 h,
    /// so a message can outlive the body it points at.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires: Option<u64>,
}

/// Where a plan-review body lives, and how to verify it once fetched.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)] // contract surface; consumed by the review lanes
pub struct PlanPayloadRef {
    /// "inline" or "attachment".
    #[serde(default)]
    pub kind: String,
    /// inline only: the encrypted-envelope JSON string produced by encrypt().
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    /// sha256 hex of the payload plaintext (the base64(gzip(bodyJson)) string).
    #[serde(default)]
    pub content_hash: String,
    /// utf-8 byte length of that same payload plaintext.
    #[serde(default)]
    pub content_length: u64,
}

/// The gzipped body of a plan_review message.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)] // contract surface; consumed by the review lanes
pub struct PlanReviewBody {
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub diff: String,
}

/// Published by the MCP server when the agent calls ReviewPlan.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)] // contract surface; consumed by the review lanes
pub struct PlanReviewMessage {
    #[serde(rename = "type")]
    pub msg_type: String,
    #[serde(default)]
    pub message_id: String,
    #[serde(default)]
    pub timestamp: u64,
    #[serde(default)]
    pub protocol_version: Option<u32>,
    #[serde(default)]
    pub repo: Option<RepoContext>,
    #[serde(default)]
    pub context: String,
    #[serde(default)]
    pub summary: String,
    /// Repo-relative only — never an absolute path.
    #[serde(default)]
    pub display_path: String,
    /// Identity hash of the plan file location; keys drafts across revisions.
    #[serde(default)]
    pub plan_id: String,
    #[serde(default)]
    pub revision: u32,
    #[serde(default)]
    pub is_new_plan: bool,
    /// "sha256:<hex>" of the plan file content.
    #[serde(default)]
    pub snapshot_hash: String,
    #[serde(default)]
    pub body: Option<PlanPayloadRef>,
}

/// A single line-anchored comment, in source-line space.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)] // contract surface; consumed by the review lanes
pub struct InlineComment {
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub start_line: u32,
    #[serde(default)]
    pub end_line: u32,
    /// "old" or "new".
    #[serde(default)]
    pub side: String,
    #[serde(default)]
    pub comment: String,
}

/// The gzipped body of a plan_review_response message.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)] // contract surface; consumed by the review lanes
pub struct PlanReviewResponseBody {
    #[serde(default)]
    pub overall_feedback: String,
    #[serde(default)]
    pub inline_comments: Vec<InlineComment>,
}

/// Published by this client when the human finishes reviewing.
/// Publishers must set `protocol_version` to `Some(SUPPORTED_PROTOCOL_VERSION)`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)] // contract surface; consumed by the review lanes
pub struct PlanReviewResponseMessage {
    #[serde(rename = "type")]
    pub msg_type: String,
    #[serde(default)]
    pub message_id: String,
    #[serde(default)]
    pub timestamp: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol_version: Option<u32>,
    /// messageId of the plan_review being answered.
    #[serde(default)]
    pub review_id: String,
    #[serde(default)]
    pub responded_from: String,
    /// approved | changes_requested | rejected | skipped | cancelled.
    #[serde(default)]
    pub verdict: String,
    #[serde(default)]
    pub snapshot_hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<PlanPayloadRef>,
}

/// Published by the server once it has actually read a response body.
///
/// Without it the client would show "submitted" at click time even when the
/// response attachment later 404s — attachments expire in 3 h, messages in 12 h.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)] // contract surface; consumed by the review lanes
pub struct PlanReviewAckMessage {
    #[serde(rename = "type")]
    pub msg_type: String,
    #[serde(default)]
    pub message_id: String,
    #[serde(default)]
    pub timestamp: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol_version: Option<u32>,
    #[serde(default)]
    pub review_id: String,
    #[serde(default)]
    pub response_id: String,
    /// "received" or "lost".
    #[serde(default)]
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Published by the server when an outstanding review will never be read.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)] // contract surface; consumed by the review lanes
pub struct CancelReviewMessage {
    #[serde(rename = "type")]
    pub msg_type: String,
    #[serde(default)]
    pub message_id: String,
    #[serde(default)]
    pub timestamp: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol_version: Option<u32>,
    #[serde(default)]
    pub review_id: String,
    /// agent_exited | cancelled | superseded.
    #[serde(default)]
    pub reason: String,
}

/// Application config from ~/.hitl/config.json
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HitlConfig {
    pub topic_id: String,
    pub ntfy_url: String,
    pub device_name: String,
    pub sound_enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encryption_key: Option<String>,
}

impl Default for HitlConfig {
    fn default() -> Self {
        Self {
            topic_id: String::new(),
            ntfy_url: "https://ntfy.sh".to_string(),
            device_name: hostname::get()
                .map(|h| h.to_string_lossy().to_string())
                .unwrap_or_else(|_| "unknown".to_string()),
            sound_enabled: true,
            encryption_key: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn question_message_deserializes_when_sub_question_omits_question_field() {
        // Real payload shape published by an unpatched (pre-2.9.2) server:
        // each sub-question has no "question" key at all, only header/options.
        let raw = r#"{
            "type": "question",
            "messageId": "21ba33d7-08a8-4761-9abf-5f4e6ba364b1",
            "timestamp": 1,
            "repo": null,
            "context": "Hetzner FX reconciliation",
            "question": "",
            "options": [],
            "allowMultiple": false,
            "allowOther": true,
            "timeout": 3600000,
            "questions": [
                {
                    "header": "AP account",
                    "options": [{"label": "A", "value": "a"}],
                    "allowMultiple": false,
                    "allowOther": true
                }
            ]
        }"#;

        let msg: QuestionMessage =
            serde_json::from_str(raw).expect("must tolerate missing sub-question.question");
        assert_eq!(msg.questions.unwrap()[0].question, "");
    }

    #[test]
    fn question_message_deserializes_when_option_omits_value_field() {
        // Real payload shape: an agent calls the tool the way it calls the
        // built-in AskUserQuestion (which has no `value` field), so each option
        // has only label/description and no "value" key at all. The Rust client
        // must tolerate that instead of failing the whole message's
        // deserialization silently (which drops the popup entirely).
        let raw = r#"{
            "type": "question",
            "messageId": "21ba33d7-08a8-4761-9abf-5f4e6ba364b1",
            "timestamp": 1,
            "repo": null,
            "context": "Audited review branches",
            "question": "Delete the stale review branches?",
            "options": [
                {"label": "Delete the 2 stale branches", "description": "Notes already on main"},
                {"label": "Leave them", "description": "Harmless but stale"}
            ],
            "allowMultiple": false,
            "allowOther": true,
            "timeout": 600000
        }"#;

        let msg: QuestionMessage =
            serde_json::from_str(raw).expect("must tolerate an option with no `value` key");
        assert_eq!(msg.options.len(), 2);
        assert_eq!(msg.options[0].value, "");
    }

    #[test]
    fn question_message_deserializes_when_batch_option_omits_value_field() {
        // Same defect, one layer deeper: batch sub-question options omit `value`.
        let raw = r#"{
            "type": "question",
            "messageId": "31ba33d7-08a8-4761-9abf-5f4e6ba364b2",
            "timestamp": 1,
            "repo": null,
            "context": "batch",
            "question": "",
            "options": [],
            "allowMultiple": false,
            "allowOther": true,
            "questions": [
                {
                    "question": "Pick one",
                    "options": [{"label": "A"}, {"label": "B"}]
                }
            ]
        }"#;

        let msg: QuestionMessage =
            serde_json::from_str(raw).expect("must tolerate a batch option with no `value` key");
        assert_eq!(msg.questions.unwrap()[0].options[0].value, "");
    }

    // --- Envelope-first dispatch (S0.2) ---

    #[test]
    fn envelope_parses_a_message_whose_concrete_type_would_fail() {
        // A question published by a peer that omits fields QuestionMessage
        // declares as required. The concrete parse fails; the envelope must
        // still yield the type and id so dispatch can log it by name instead
        // of dropping it with no window and no trace.
        let raw = r#"{
            "type": "question",
            "messageId": "abc-123",
            "timestamp": 42,
            "fieldsWeHaveNeverHeardOf": {"nested": [1, 2, 3]}
        }"#;

        assert!(serde_json::from_str::<QuestionMessage>(raw).is_err());

        let env: MessageEnvelope = serde_json::from_str(raw).expect("envelope must still parse");
        assert_eq!(env.msg_type, "question");
        assert_eq!(env.message_id, "abc-123");
        assert_eq!(env.version(), 1);
    }

    #[test]
    fn envelope_reports_a_version_this_build_does_not_support() {
        let raw = r#"{"type":"plan_review","messageId":"r1","protocolVersion":9}"#;

        let env: MessageEnvelope = serde_json::from_str(raw).unwrap();
        assert_eq!(env.version(), 9);
        assert!(env.version() > SUPPORTED_PROTOCOL_VERSION);
    }

    #[test]
    fn envelope_treats_an_absent_protocol_version_as_1() {
        // Every shipping message looks like this. It must never trip the
        // "too new, upgrade required" branch.
        let raw = r#"{"type":"question","messageId":"q1","timestamp":1}"#;

        let env: MessageEnvelope = serde_json::from_str(raw).unwrap();
        assert_eq!(env.protocol_version, None);
        assert_eq!(env.version(), 1);
        assert!(env.version() <= SUPPORTED_PROTOCOL_VERSION);
    }

    #[test]
    fn envelope_rejects_a_message_with_no_type() {
        assert!(serde_json::from_str::<MessageEnvelope>(r#"{"messageId":"x"}"#).is_err());
    }

    // --- Plan-review types deserialize with every optional field omitted (A-6) ---

    #[test]
    fn plan_review_deserializes_with_only_its_type() {
        let msg: PlanReviewMessage =
            serde_json::from_str(r#"{"type":"plan_review"}"#).expect("must tolerate a bare type");

        assert_eq!(msg.msg_type, "plan_review");
        assert_eq!(msg.protocol_version, None);
        assert_eq!(msg.revision, 0);
        assert!(!msg.is_new_plan);
        assert!(msg.repo.is_none());
        assert!(msg.body.is_none());
        assert_eq!(msg.summary, "");
    }

    #[test]
    fn plan_review_deserializes_a_full_message() {
        let raw = r#"{
            "type": "plan_review",
            "messageId": "rev-1",
            "timestamp": 1700000000000,
            "protocolVersion": 2,
            "repo": {"name": "HumanInTheLoop", "branch": "master"},
            "context": "Reviewing S0",
            "summary": "Contract gate",
            "displayPath": "docs/plan.md",
            "planId": "aaaa",
            "revision": 3,
            "isNewPlan": false,
            "snapshotHash": "sha256:bbbb",
            "body": {"kind":"attachment","contentHash":"cccc","contentLength":7120}
        }"#;

        let msg: PlanReviewMessage = serde_json::from_str(raw).unwrap();
        assert_eq!(msg.protocol_version, Some(2));
        assert_eq!(msg.revision, 3);
        assert_eq!(msg.display_path, "docs/plan.md");
        let body = msg.body.unwrap();
        assert_eq!(body.kind, "attachment");
        assert!(body.data.is_none());
        assert_eq!(body.content_length, 7120);
    }

    #[test]
    fn plan_review_response_deserializes_with_only_its_type() {
        let msg: PlanReviewResponseMessage =
            serde_json::from_str(r#"{"type":"plan_review_response"}"#).unwrap();

        assert_eq!(msg.verdict, "");
        assert_eq!(msg.review_id, "");
        assert!(msg.body.is_none());
    }

    #[test]
    fn plan_review_response_tolerates_an_unrecognized_verdict() {
        // verdict is a String, not an enum, precisely so a value added by a
        // newer peer does not fail the whole message.
        let raw = r#"{"type":"plan_review_response","reviewId":"r1","verdict":"needs_pairing"}"#;

        let msg: PlanReviewResponseMessage = serde_json::from_str(raw).unwrap();
        assert_eq!(msg.verdict, "needs_pairing");
    }

    #[test]
    fn plan_review_response_round_trips_and_emits_camel_case() {
        let msg = PlanReviewResponseMessage {
            msg_type: "plan_review_response".to_string(),
            message_id: "resp-1".to_string(),
            timestamp: 1,
            protocol_version: Some(SUPPORTED_PROTOCOL_VERSION),
            review_id: "rev-1".to_string(),
            responded_from: "laptop".to_string(),
            verdict: "changes_requested".to_string(),
            snapshot_hash: "sha256:bbbb".to_string(),
            body: Some(PlanPayloadRef {
                kind: "inline".to_string(),
                data: Some("{\"_encrypted\":true}".to_string()),
                content_hash: "cccc".to_string(),
                content_length: 12,
            }),
        };

        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"protocolVersion\":2"), "{json}");
        assert!(json.contains("\"reviewId\":\"rev-1\""), "{json}");
        assert!(json.contains("\"contentHash\":\"cccc\""), "{json}");

        let back: PlanReviewResponseMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(back.verdict, "changes_requested");
        assert_eq!(back.body.unwrap().content_length, 12);
    }

    #[test]
    fn plan_review_ack_deserializes_with_only_its_type() {
        let msg: PlanReviewAckMessage =
            serde_json::from_str(r#"{"type":"plan_review_ack"}"#).unwrap();

        assert_eq!(msg.status, "");
        assert!(msg.reason.is_none());
    }

    #[test]
    fn plan_review_ack_carries_status_and_reason() {
        let raw = r#"{"type":"plan_review_ack","reviewId":"r1","responseId":"p1",
                      "status":"lost","reason":"attachment expired"}"#;

        let msg: PlanReviewAckMessage = serde_json::from_str(raw).unwrap();
        assert_eq!(msg.status, "lost");
        assert_eq!(msg.reason.as_deref(), Some("attachment expired"));
    }

    #[test]
    fn cancel_review_deserializes_with_only_its_type_and_tolerates_a_new_reason() {
        let bare: CancelReviewMessage =
            serde_json::from_str(r#"{"type":"cancel_review"}"#).unwrap();
        assert_eq!(bare.reason, "");

        let future: CancelReviewMessage = serde_json::from_str(
            r#"{"type":"cancel_review","reviewId":"r1","reason":"host_restarted"}"#,
        )
        .unwrap();
        assert_eq!(future.reason, "host_restarted");
    }

    #[test]
    fn inline_comment_round_trips_in_source_line_space() {
        let body = PlanReviewResponseBody {
            overall_feedback: "Two notes.".to_string(),
            inline_comments: vec![InlineComment {
                path: "plan.md".to_string(),
                start_line: 42,
                end_line: 47,
                side: "new".to_string(),
                comment: "Widen this range.".to_string(),
            }],
        };

        let json = serde_json::to_string(&body).unwrap();
        assert!(json.contains("\"startLine\":42"), "{json}");
        assert!(json.contains("\"overallFeedback\""), "{json}");

        let back: PlanReviewResponseBody = serde_json::from_str(&json).unwrap();
        assert_eq!(back.inline_comments[0].end_line, 47);
        assert_eq!(back.inline_comments[0].side, "new");
    }

    #[test]
    fn plan_review_body_deserializes_with_both_fields_omitted() {
        let body: PlanReviewBody = serde_json::from_str("{}").unwrap();
        assert_eq!(body.content, "");
        assert_eq!(body.diff, "");
    }

    #[test]
    fn attachment_ref_parses_ntfy_event_metadata_verbatim() {
        // Exact shape returned by GET /{topic}/json, captured from ntfy.sh.
        let raw = r#"{"name":"qurRQchLV1Fb.bin","type":"application/octet-stream",
                      "size":5000,"expires":1786514937,
                      "url":"https://ntfy.sh/file/qurRQchLV1Fb.bin"}"#;

        let att: AttachmentRef = serde_json::from_str(raw).unwrap();
        assert_eq!(att.url, "https://ntfy.sh/file/qurRQchLV1Fb.bin");
        assert_eq!(att.content_type.as_deref(), Some("application/octet-stream"));
        assert_eq!(att.size, Some(5000));
        assert_eq!(att.expires, Some(1786514937));
    }

    #[test]
    fn attachment_ref_tolerates_a_url_only_event() {
        let att: AttachmentRef =
            serde_json::from_str(r#"{"url":"https://ntfy.sh/file/x.bin"}"#).unwrap();
        assert_eq!(att.name, "");
        assert!(att.size.is_none());
    }
}
