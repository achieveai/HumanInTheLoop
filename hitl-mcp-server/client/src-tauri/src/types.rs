use serde::{Deserialize, Serialize};

/// A selectable option presented to the human.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DialogOption {
    pub label: String,
    pub value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
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
