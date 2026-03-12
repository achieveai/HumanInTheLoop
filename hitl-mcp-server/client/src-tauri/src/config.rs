use std::fs;
use std::path::PathBuf;

use crate::types::HitlConfig;

/// Get the path to the config file (~/.hitl/config.json).
pub fn config_path() -> PathBuf {
    dirs::home_dir()
        .expect("Could not determine home directory")
        .join(".hitl")
        .join("config.json")
}

/// Load config from ~/.hitl/config.json.
pub fn load_config() -> Result<HitlConfig, String> {
    let path = config_path();
    if !path.exists() {
        return Err(format!(
            "Config not found at {}. Run 'hitl init' to create one.",
            path.display()
        ));
    }

    let content = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read config: {}", e))?;

    let config: HitlConfig = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse config: {}", e))?;

    if config.topic_id.is_empty() {
        return Err("Config is missing 'topicId'".to_string());
    }

    Ok(config)
}
