use std::path::Path;

use hitl_transport::types::HitlConfig;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInput {
    pub ntfy_url: String,
    pub topic_id: String,
    /// Blank on an edit keeps the saved key, so the phone never has to show it.
    pub encryption_key: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionSettings {
    pub mobile: bool,
    pub configured: bool,
    pub topic_id: Option<String>,
    /// Mobile only: the one place it can be edited. Desktop keeps it private.
    pub ntfy_url: Option<String>,
}

fn config_path(dir: &Path) -> std::path::PathBuf {
    dir.join("config.json")
}

fn recovery_error() -> String {
    "Stored connection settings are unreadable or invalid. Enter them again to repair them.".to_string()
}

/// The server as typed, without a trailing slash. HTTPS only: the phone talks
/// to it over networks you do not control.
fn normalize_url(url: &str) -> Result<String, String> {
    let url = url.trim().trim_end_matches('/');
    let host = url.strip_prefix("https://").unwrap_or("");
    if host.is_empty()
        || url.len() > 200
        || host
            .bytes()
            .any(|byte| byte.is_ascii_whitespace() || matches!(byte, b'?' | b'#' | b'@'))
    {
        return Err("Server must be an https:// address, such as https://ntfy.sh.".to_string());
    }
    Ok(url.to_string())
}

fn validate(input: &ConnectionInput) -> Result<(), String> {
    let topic = input.topic_id.as_str();
    if topic.is_empty()
        || topic.len() > 64
        || topic.trim() != topic
        || !topic
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(
            "Topic ID must be 1–64 letters, numbers, hyphens, underscores, or periods.".to_string(),
        );
    }

    if input.encryption_key.len() != 64
        || !input
            .encryption_key
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("Encryption key must be exactly 64 hexadecimal characters.".to_string());
    }
    Ok(())
}

pub fn load_public_at(dir: &Path, mobile: bool) -> Result<ConnectionSettings, String> {
    let path = config_path(dir);
    if !path.exists() {
        return Ok(ConnectionSettings {
            mobile,
            configured: false,
            topic_id: None,
            ntfy_url: None,
        });
    }

    let contents = std::fs::read_to_string(&path).map_err(|_| recovery_error())?;
    let config: HitlConfig = serde_json::from_str(&contents).map_err(|_| recovery_error())?;
    if mobile {
        let input = ConnectionInput {
            ntfy_url: config.ntfy_url.clone(),
            topic_id: config.topic_id.clone(),
            encryption_key: config.encryption_key.clone().ok_or_else(recovery_error)?,
        };
        validate(&input).map_err(|_| recovery_error())?;
        normalize_url(&input.ntfy_url).map_err(|_| recovery_error())?;
    } else if config.topic_id.is_empty() {
        // Desktop preserves the transport's existing cleartext configuration
        // contract: a topic is required, while encryption remains optional.
        return Err(recovery_error());
    }

    Ok(ConnectionSettings {
        mobile,
        configured: true,
        topic_id: Some(config.topic_id),
        ntfy_url: mobile.then_some(config.ntfy_url),
    })
}

/// Save the connection. Returns whether it changed, so the caller knows to
/// reconnect. Fields this screen does not own (device name, sound) are kept.
pub fn save_at(dir: &Path, mut input: ConnectionInput) -> Result<bool, String> {
    let path = config_path(dir);
    // An unreadable file is what a full re-entry repairs, so it is replaced
    // rather than refused. Only a readable one can lend its key to an edit.
    let existing: Option<HitlConfig> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|contents| serde_json::from_str(&contents).ok());
    if input.encryption_key.is_empty() {
        if let Some(key) = existing.as_ref().and_then(|c| c.encryption_key.clone()) {
            input.encryption_key = key;
        }
    }
    let ntfy_url = normalize_url(&input.ntfy_url)?;
    validate(&input)?;

    let mut config = existing.clone().unwrap_or_default();
    config.ntfy_url = ntfy_url;
    config.topic_id = input.topic_id;
    config.encryption_key = Some(input.encryption_key);
    let same = |a: &HitlConfig| serde_json::to_value(a).ok() == serde_json::to_value(&config).ok();
    if existing.as_ref().is_some_and(same) {
        return Ok(false);
    }

    std::fs::create_dir_all(dir)
        .map_err(|error| format!("Could not create settings directory: {error}"))?;
    let json = serde_json::to_string_pretty(&config)
        .map_err(|error| format!("Could not encode connection settings: {error}"))?;
    let temporary = dir.join(format!(".config-{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&temporary, json)
        .map_err(|error| format!("Could not stage connection settings: {error}"))?;
    if let Err(error) = std::fs::rename(&temporary, path) {
        let _ = std::fs::remove_file(temporary);
        return Err(format!("Could not save connection settings: {error}"));
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::{load_public_at, save_at, ConnectionInput};
    use hitl_transport::types::HitlConfig;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "hitl-inbox-settings-{name}-{}",
            uuid::Uuid::new_v4()
        ))
    }

    fn valid_input() -> ConnectionInput {
        ConnectionInput {
            ntfy_url: "https://ntfy.example.test".to_string(),
            topic_id: "phone-topic_123".to_string(),
            encryption_key: "ab".repeat(32),
        }
    }

    #[test]
    fn blank_or_invalid_topics_are_rejected() {
        for topic_id in ["", "   ", "has space", "slash/topic", "question?"] {
            let mut input = valid_input();
            input.topic_id = topic_id.to_string();
            assert!(
                save_at(&temp_dir("bad-topic"), input).is_err(),
                "accepted {topic_id:?}"
            );
        }
    }

    #[test]
    fn keys_must_be_exactly_64_hex_characters() {
        for encryption_key in [
            String::new(),
            "ab".to_string(),
            "a".repeat(63),
            "a".repeat(65),
            "g".repeat(64),
        ] {
            let mut input = valid_input();
            input.encryption_key = encryption_key;
            assert!(save_at(&temp_dir("bad-key"), input).is_err());
        }
    }

    #[test]
    fn valid_settings_roundtrip_without_exposing_the_key() {
        let dir = temp_dir("roundtrip");
        let input = valid_input();
        save_at(&dir, input.clone()).unwrap();

        let public = load_public_at(&dir, true).unwrap();
        assert!(public.mobile);
        assert!(public.configured);
        assert_eq!(public.topic_id.as_deref(), Some("phone-topic_123"));
        let json = serde_json::to_string(&public).unwrap();
        assert!(!json.contains(&input.encryption_key));
        assert!(!json.contains("encryptionKey"));

        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn desktop_accepts_an_existing_cleartext_connection_without_exposing_secrets() {
        let dir = temp_dir("desktop-cleartext");
        std::fs::create_dir_all(&dir).unwrap();
        let config = HitlConfig {
            topic_id: "legacy-desktop-topic".to_string(),
            ntfy_url: "https://ntfy.example.test".to_string(),
            device_name: "desktop".to_string(),
            sound_enabled: false,
            encryption_key: None,
        };
        std::fs::write(
            dir.join("config.json"),
            serde_json::to_string_pretty(&config).unwrap(),
        )
        .unwrap();

        let public = load_public_at(&dir, false).unwrap();

        assert!(!public.mobile);
        assert!(public.configured);
        assert_eq!(public.topic_id.as_deref(), Some("legacy-desktop-topic"));
        let json = serde_json::to_string(&public).unwrap();
        assert!(!json.contains("encryptionKey"));
        assert!(!json.contains("ntfy.example.test"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn mobile_rejects_the_same_cleartext_connection() {
        let dir = temp_dir("mobile-cleartext");
        std::fs::create_dir_all(&dir).unwrap();
        let config = HitlConfig {
            topic_id: "legacy-desktop-topic".to_string(),
            encryption_key: None,
            ..HitlConfig::default()
        };
        std::fs::write(
            dir.join("config.json"),
            serde_json::to_string_pretty(&config).unwrap(),
        )
        .unwrap();

        let error = load_public_at(&dir, true).unwrap_err();

        assert!(
            error.contains("repair"),
            "{error}"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn desktop_still_rejects_a_connection_without_a_topic() {
        let dir = temp_dir("desktop-missing-topic");
        std::fs::create_dir_all(&dir).unwrap();
        let config = HitlConfig {
            encryption_key: None,
            ..HitlConfig::default()
        };
        std::fs::write(
            dir.join("config.json"),
            serde_json::to_string_pretty(&config).unwrap(),
        )
        .unwrap();

        let error = load_public_at(&dir, false).unwrap_err();

        assert!(
            error.contains("repair"),
            "{error}"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_server_must_be_https() {
        for ntfy_url in ["", "http://ntfy.example.test", "ntfy.example.test", "https://", "https://a b", "https://x?y"] {
            let mut input = valid_input();
            input.ntfy_url = ntfy_url.to_string();
            assert!(save_at(&temp_dir("bad-url"), input).is_err(), "accepted {ntfy_url:?}");
        }
    }

    #[test]
    fn mobile_shows_the_server_it_saved_without_a_trailing_slash() {
        let dir = temp_dir("url");
        let mut input = valid_input();
        input.ntfy_url = "https://ntfy.example.test/".to_string();
        assert!(save_at(&dir, input).unwrap());

        let public = load_public_at(&dir, true).unwrap();
        assert_eq!(public.ntfy_url.as_deref(), Some("https://ntfy.example.test"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn server_topic_and_key_can_all_change_later() {
        let dir = temp_dir("change");
        save_at(&dir, valid_input()).unwrap();
        let changed = ConnectionInput {
            ntfy_url: "https://other.example.test".to_string(),
            topic_id: "different-topic".to_string(),
            encryption_key: "cd".repeat(32),
        };
        assert!(save_at(&dir, changed).unwrap(), "a change reports changed");

        let saved: HitlConfig =
            serde_json::from_str(&std::fs::read_to_string(dir.join("config.json")).unwrap()).unwrap();
        assert_eq!(saved.ntfy_url, "https://other.example.test");
        assert_eq!(saved.topic_id, "different-topic");
        assert_eq!(saved.encryption_key, Some("cd".repeat(32)));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_blank_key_on_an_edit_keeps_the_saved_key() {
        let dir = temp_dir("keep-key");
        save_at(&dir, valid_input()).unwrap();
        let mut edit = valid_input();
        edit.encryption_key = String::new();
        assert!(!save_at(&dir, edit.clone()).unwrap(), "nothing changed");

        edit.topic_id = "moved-topic".to_string();
        assert!(save_at(&dir, edit).unwrap());
        let saved: HitlConfig =
            serde_json::from_str(&std::fs::read_to_string(dir.join("config.json")).unwrap()).unwrap();
        assert_eq!(saved.encryption_key, Some("ab".repeat(32)));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_blank_key_on_first_setup_is_refused() {
        let mut input = valid_input();
        input.encryption_key = String::new();
        assert!(save_at(&temp_dir("first-blank"), input).is_err());
    }

    #[test]
    fn resaving_identical_connection_does_not_replace_existing_config_fields() {
        let dir = temp_dir("preserve");
        std::fs::create_dir_all(&dir).unwrap();
        let original = HitlConfig {
            topic_id: "phone-topic_123".to_string(),
            ntfy_url: "https://ntfy.example.test".to_string(),
            device_name: "pixel".to_string(),
            sound_enabled: false,
            encryption_key: Some("ab".repeat(32)),
        };
        std::fs::write(
            dir.join("config.json"),
            serde_json::to_string_pretty(&original).unwrap(),
        )
        .unwrap();

        save_at(&dir, valid_input()).unwrap();

        let saved: HitlConfig = serde_json::from_str(
            &std::fs::read_to_string(dir.join("config.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(saved.ntfy_url, "https://ntfy.example.test");
        assert_eq!(saved.device_name, "pixel");
        assert!(!saved.sound_enabled);

        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn persisted_invalid_topic_or_key_is_not_reported_as_configured() {
        for (topic_id, encryption_key) in [
            ("bad/topic", Some("ab".repeat(32))),
            ("phone-topic", None),
            ("phone-topic", Some(String::new())),
            ("phone-topic", Some("g".repeat(64))),
        ] {
            let dir = temp_dir("invalid-persisted");
            std::fs::create_dir_all(&dir).unwrap();
            let config = HitlConfig {
                topic_id: topic_id.to_string(),
                encryption_key,
                ..HitlConfig::default()
            };
            std::fs::write(
                dir.join("config.json"),
                serde_json::to_string(&config).unwrap(),
            )
            .unwrap();

            let error = load_public_at(&dir, true).unwrap_err();
            assert!(error.contains("repair"), "{error}");
            // Entering the connection again repairs it.
            assert!(save_at(&dir, valid_input()).unwrap());
            assert!(load_public_at(&dir, true).unwrap().configured);
            std::fs::remove_dir_all(dir).unwrap();
        }
    }

    #[test]
    fn malformed_or_unreadable_config_returns_recovery_guidance() {
        for as_directory in [false, true] {
            let dir = temp_dir("broken-persisted");
            std::fs::create_dir_all(&dir).unwrap();
            let path = dir.join("config.json");
            if as_directory {
                std::fs::create_dir(&path).unwrap();
            } else {
                std::fs::write(&path, "{not-json").unwrap();
            }

            let error = load_public_at(&dir, true).unwrap_err();
            assert!(error.contains("repair"), "{error}");
            if as_directory {
                // Nothing can be written over a directory; the save says so.
                assert!(save_at(&dir, valid_input()).is_err());
            } else {
                // Entering the connection again repairs it.
                assert!(save_at(&dir, valid_input()).unwrap());
                assert!(load_public_at(&dir, true).unwrap().configured);
            }
            std::fs::remove_dir_all(dir).unwrap();
        }
    }
}
