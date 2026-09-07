use std::path::Path;

use hitl_transport::types::HitlConfig;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInput {
    pub topic_id: String,
    pub encryption_key: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionSettings {
    pub mobile: bool,
    pub configured: bool,
    pub topic_id: Option<String>,
}

fn config_path(dir: &Path) -> std::path::PathBuf {
    dir.join("config.json")
}

fn recovery_error() -> String {
    "Stored connection settings are unreadable or invalid. Reset or reinstall the app, then try again."
        .to_string()
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
        });
    }

    let contents = std::fs::read_to_string(&path).map_err(|_| recovery_error())?;
    let config: HitlConfig = serde_json::from_str(&contents).map_err(|_| recovery_error())?;
    if mobile {
        let input = ConnectionInput {
            topic_id: config.topic_id.clone(),
            encryption_key: config.encryption_key.clone().ok_or_else(recovery_error)?,
        };
        validate(&input).map_err(|_| recovery_error())?;
    } else if config.topic_id.is_empty() {
        // Desktop preserves the transport's existing cleartext configuration
        // contract: a topic is required, while encryption remains optional.
        return Err(recovery_error());
    }

    Ok(ConnectionSettings {
        mobile,
        configured: true,
        topic_id: Some(config.topic_id),
    })
}

pub fn save_at(dir: &Path, input: ConnectionInput) -> Result<(), String> {
    validate(&input)?;
    std::fs::create_dir_all(dir)
        .map_err(|error| format!("Could not create settings directory: {error}"))?;

    let path = config_path(dir);
    if path.exists() {
        let contents = std::fs::read_to_string(&path).map_err(|_| recovery_error())?;
        let existing: HitlConfig =
            serde_json::from_str(&contents).map_err(|_| recovery_error())?;
        if !existing.topic_id.is_empty() && existing.topic_id != input.topic_id {
            return Err(
                "Changing topics is not supported yet. Reset or reinstall the app first."
                    .to_string(),
            );
        }
        if existing.encryption_key.as_deref() != Some(input.encryption_key.as_str()) {
            return Err(
                "Changing the encryption key is not supported yet. Reset or reinstall the app first."
                    .to_string(),
            );
        }
        // The running subscriber loaded this exact connection once. Leaving
        // the document untouched preserves all unrelated desktop fields.
        return Ok(());
    }

    let config = HitlConfig {
        topic_id: input.topic_id,
        encryption_key: Some(input.encryption_key),
        ..HitlConfig::default()
    };
    let json = serde_json::to_string_pretty(&config)
        .map_err(|error| format!("Could not encode connection settings: {error}"))?;
    let temporary = dir.join(format!(".config-{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&temporary, json)
        .map_err(|error| format!("Could not stage connection settings: {error}"))?;
    if let Err(error) = std::fs::rename(&temporary, path) {
        let _ = std::fs::remove_file(temporary);
        return Err(format!("Could not save connection settings: {error}"));
    }
    Ok(())
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
            error.contains("reset") || error.contains("reinstall"),
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
            error.contains("reset") || error.contains("reinstall"),
            "{error}"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn changing_an_existing_topic_is_rejected_with_reset_guidance() {
        let dir = temp_dir("topic-change");
        save_at(&dir, valid_input()).unwrap();
        let mut changed = valid_input();
        changed.topic_id = "different-topic".to_string();

        let error = save_at(&dir, changed).unwrap_err();
        assert!(
            error.contains("reinstall") || error.contains("reset"),
            "{error}"
        );

        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn changing_an_existing_key_is_rejected_instead_of_splitting_live_services() {
        let dir = temp_dir("key-change");
        save_at(&dir, valid_input()).unwrap();
        let mut changed = valid_input();
        changed.encryption_key = "cd".repeat(32);

        let error = save_at(&dir, changed).unwrap_err();
        assert!(error.contains("reinstall") || error.contains("reset"), "{error}");

        std::fs::remove_dir_all(dir).unwrap();
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
            assert!(error.contains("reset") || error.contains("reinstall"), "{error}");
            let save_error = save_at(&dir, valid_input()).unwrap_err();
            assert!(
                save_error.contains("reset") || save_error.contains("reinstall"),
                "{save_error}"
            );
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
            assert!(error.contains("reset") || error.contains("reinstall"), "{error}");
            let save_error = save_at(&dir, valid_input()).unwrap_err();
            assert!(
                save_error.contains("reset") || save_error.contains("reinstall"),
                "{save_error}"
            );
            std::fs::remove_dir_all(dir).unwrap();
        }
    }
}
