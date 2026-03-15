use serde::{Deserialize, Serialize};

/// A selectable option presented to the human.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DialogOption {
    pub label: String,
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

/// Application config from ~/.hitl/config.json
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HitlConfig {
    pub topic_id: String,
    pub ntfy_url: String,
    pub device_name: String,
    pub sound_enabled: bool,
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
        }
    }
}
