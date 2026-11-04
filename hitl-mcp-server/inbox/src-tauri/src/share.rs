//! Sharing the connection from desktop to Android as a QR code.
//!
//! The payload is a versioned `hitl-inbox://connect` URI carrying the server,
//! topic and encryption key. Whoever holds it can read *and answer* the inbox,
//! so two rules hold everywhere in this module:
//!
//! - The key never crosses into JavaScript as text. The desktop hands the
//!   WebView an SVG image; the phone hands it only the server and topic for
//!   confirmation. Parsing, validation and saving all happen here in Rust.
//! - Import validation is exactly the manual-entry validation: an HTTPS
//!   server, the topic charset and a 64-hex key, reused from `settings`.

use std::path::Path;

use hitl_transport::types::HitlConfig;
use serde::Serialize;

use crate::settings::{self, ConnectionInput};

/// What the desktop encodes and the phone parses. Version 1 is the three
/// connection fields; a later one-time-pairing flow would use a new version
/// rather than changing the meaning of these parameters.
const PREFIX: &str = "hitl-inbox://connect?";
const MAX_URI_LEN: usize = 2048;

/// Where MainActivity parks a scanned link until the WebView claims it.
const PENDING_FILE: &str = "pending-connection-import";

/// What the import confirmation shows. Deliberately no key: the person checks
/// where they are connecting, and the secret itself stays out of the page.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub server: String,
    pub topic_id: String,
}

fn encode_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn decode_component(value: &str) -> Result<String, String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return Err("The connection code is truncated.".to_string());
            }
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3])
                .ok()
                .and_then(|h| u8::from_str_radix(h, 16).ok())
                .ok_or_else(|| "The connection code has invalid escaping.".to_string())?;
            out.push(hex);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "The connection code is not valid text.".to_string())
}

/// The URI behind the QR. Built from the stored config, so what the phone
/// receives is exactly what the desktop uses — never a re-typed copy.
pub fn build_payload(input: &ConnectionInput) -> String {
    format!(
        "{PREFIX}v=1&server={}&topic={}&key={}",
        encode_component(&input.ntfy_url),
        encode_component(&input.topic_id),
        encode_component(&input.encryption_key),
    )
}

/// Structural parse, then the same field validation as manual entry.
pub fn parse_payload(uri: &str) -> Result<ConnectionInput, String> {
    if uri.len() > MAX_URI_LEN {
        return Err("The connection code is too long to be a HITL connection.".to_string());
    }
    let query = uri
        .strip_prefix(PREFIX)
        .ok_or_else(|| "Not a HITL Inbox connection code.".to_string())?;

    let mut server = None;
    let mut topic = None;
    let mut key = None;
    let mut version = None;
    for pair in query.split('&') {
        let Some((name, value)) = pair.split_once('=') else {
            return Err("The connection code is malformed.".to_string());
        };
        let slot = match name {
            "v" => &mut version,
            "server" => &mut server,
            "topic" => &mut topic,
            "key" => &mut key,
            // Unknown parameters are ignored so a later version can add
            // fields without breaking phones that only understand v1.
            _ => continue,
        };
        if slot.is_some() {
            return Err(format!("The connection code repeats '{name}'."));
        }
        *slot = Some(decode_component(value)?);
    }

    if version.as_deref() != Some("1") {
        return Err("This connection code is from an incompatible app version.".to_string());
    }
    let mut input = ConnectionInput {
        ntfy_url: server.ok_or_else(|| "The connection code has no server.".to_string())?,
        topic_id: topic.ok_or_else(|| "The connection code has no topic.".to_string())?,
        encryption_key: key.ok_or_else(|| "The connection code has no key.".to_string())?,
    };
    settings::validate(&input)?;
    input.ntfy_url = settings::normalize_url(&input.ntfy_url)?;
    Ok(input)
}

pub fn inspect(uri: &str) -> Result<ImportPreview, String> {
    let input = parse_payload(uri)?;
    Ok(ImportPreview {
        server: input.ntfy_url,
        topic_id: input.topic_id,
    })
}

/// Desktop share: read the full stored connection and render it as an SVG QR.
///
/// A desktop connection may legitimately be cleartext (no key), but Android
/// requires one, so that case gets guidance rather than a code that would
/// only fail on import.
pub fn connection_qr_at(dir: &Path) -> Result<String, String> {
    let path = dir.join("config.json");
    let contents = std::fs::read_to_string(&path)
        .map_err(|_| "No saved connection to share yet.".to_string())?;
    let config: HitlConfig = serde_json::from_str(&contents)
        .map_err(|_| "The saved connection is unreadable; repair it before sharing.".to_string())?;
    let key = config.encryption_key.clone().ok_or_else(|| {
        "This connection has no encryption key. Android needs one: add a key to the HITL configuration before sharing.".to_string()
    })?;
    let input = ConnectionInput {
        ntfy_url: config.ntfy_url,
        topic_id: config.topic_id,
        encryption_key: key,
    };
    settings::validate(&input)?;
    let payload = build_payload(&input);
    let code = qrcode::QrCode::new(payload.as_bytes())
        .map_err(|error| format!("Could not encode the connection as a QR code: {error}"))?;
    Ok(code
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(280, 280)
        .build())
}

/// Android import: claim a scanned link exactly once. The file is deleted on
/// read, so the credentials do not sit in storage after the WebView has them.
pub fn take_pending_at(dir: &Path) -> Result<Option<String>, String> {
    let path = dir.join(PENDING_FILE);
    match std::fs::read_to_string(&path) {
        Ok(uri) => {
            std::fs::remove_file(&path)
                .map_err(|error| format!("Could not clear the pending import: {error}"))?;
            let uri = uri.trim().to_string();
            if uri.is_empty() {
                return Ok(None);
            }
            Ok(Some(uri))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Could not read the pending import: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn input() -> ConnectionInput {
        ConnectionInput {
            ntfy_url: "https://ntfy.example.test".to_string(),
            topic_id: "phone-topic_123".to_string(),
            encryption_key: "ab".repeat(32),
        }
    }

    #[test]
    fn a_payload_roundtrips_all_three_fields() {
        let parsed = parse_payload(&build_payload(&input())).unwrap();
        assert_eq!(parsed.ntfy_url, "https://ntfy.example.test");
        assert_eq!(parsed.topic_id, "phone-topic_123");
        assert_eq!(parsed.encryption_key, "ab".repeat(32));
    }

    #[test]
    fn percent_escaping_survives_urls_with_reserved_characters() {
        let mut with_port = input();
        with_port.ntfy_url = "https://ntfy.example.test:8443".to_string();
        let parsed = parse_payload(&build_payload(&with_port)).unwrap();
        assert_eq!(parsed.ntfy_url, "https://ntfy.example.test:8443");
        assert!(!build_payload(&with_port).contains("https://"));
    }

    #[test]
    fn non_hitl_links_are_refused() {
        for uri in [
            "https://evil.example/steal",
            "hitl-inbox://other?v=1",
            "hitl-inbox://connect",
            "",
        ] {
            assert!(parse_payload(uri).is_err(), "accepted {uri:?}");
        }
    }

    #[test]
    fn wrong_or_missing_version_is_refused() {
        let payload = build_payload(&input());
        assert!(parse_payload(&payload.replace("v=1", "v=2")).is_err());
        assert!(parse_payload(&payload.replace("v=1&", "")).is_err());
    }

    #[test]
    fn import_validation_matches_manual_entry() {
        let payload = build_payload(&input());
        // Not HTTPS.
        assert!(parse_payload(&payload.replace("https%3A%2F%2F", "http%3A%2F%2F")).is_err());
        // Bad key length.
        let short_key = payload.replace(&"ab".repeat(32), "ab");
        assert!(parse_payload(&short_key).is_err());
        // Bad topic characters.
        let bad_topic = build_payload(&input()).replace("phone-topic_123", "bad%2Ftopic");
        assert!(parse_payload(&bad_topic).is_err());
    }

    #[test]
    fn duplicated_or_truncated_parameters_are_refused() {
        let payload = build_payload(&input());
        let duplicated = format!("{payload}&topic=another");
        assert!(parse_payload(&duplicated).is_err());
        let truncated = payload.replace("https%3A%2F%2Fntfy.example.test", "https%3");
        assert!(parse_payload(&truncated).is_err());
    }

    #[test]
    fn oversized_uris_are_refused_before_any_parsing() {
        let uri = format!("{PREFIX}v=1&server={}", "a".repeat(MAX_URI_LEN));
        assert!(parse_payload(&uri).is_err());
    }

    #[test]
    fn the_preview_shows_where_but_never_the_key() {
        let preview = inspect(&build_payload(&input())).unwrap();
        let json = serde_json::to_string(&preview).unwrap();
        assert!(json.contains("ntfy.example.test"));
        assert!(json.contains("phone-topic_123"));
        assert!(!json.contains(&"ab".repeat(32)));
        assert!(!json.contains("key"));
    }

    #[test]
    fn the_qr_is_an_svg_and_a_cleartext_connection_cannot_be_shared() {
        let dir = std::env::temp_dir().join(format!("hitl-share-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut config = HitlConfig {
            topic_id: "phone-topic_123".to_string(),
            ntfy_url: "https://ntfy.example.test".to_string(),
            encryption_key: Some("ab".repeat(32)),
            ..HitlConfig::default()
        };
        let mut file = std::fs::File::create(dir.join("config.json")).unwrap();
        file.write_all(serde_json::to_string(&config).unwrap().as_bytes())
            .unwrap();

        let svg = connection_qr_at(&dir).unwrap();
        assert!(svg.contains("<svg"), "expected an SVG document");
        assert!(svg.contains("path"), "a QR is vector modules");

        config.encryption_key = None;
        std::fs::write(dir.join("config.json"), serde_json::to_string(&config).unwrap()).unwrap();
        let error = connection_qr_at(&dir).unwrap_err();
        assert!(error.contains("no encryption key"), "{error}");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_pending_import_is_claimed_exactly_once() {
        let dir = std::env::temp_dir().join(format!("hitl-pending-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(take_pending_at(&dir).unwrap(), None);

        std::fs::write(dir.join(PENDING_FILE), build_payload(&input())).unwrap();
        let claimed = take_pending_at(&dir).unwrap().unwrap();
        assert_eq!(claimed, build_payload(&input()));
        assert!(!dir.join(PENDING_FILE).exists(), "the secret is deleted on read");
        assert_eq!(take_pending_at(&dir).unwrap(), None, "a second scan imports nothing");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
