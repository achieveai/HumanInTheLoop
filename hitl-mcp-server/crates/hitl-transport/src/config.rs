use std::fs;
use std::path::PathBuf;

use crate::types::HitlConfig;

/// Get the path to the config file, wherever this platform keeps it.
///
/// This was an infallible `PathBuf` that `.expect()`ed a home directory.
/// Android has none, so the old signature could not express its own failure
/// and panicked instead of reporting it. See [`crate::paths`].
pub fn config_path() -> Result<PathBuf, String> {
    Ok(crate::paths::hitl_dir()?.join("config.json"))
}

/// Load config from this platform's `config.json`.
pub fn load_config() -> Result<HitlConfig, String> {
    let path = config_path()?;
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
