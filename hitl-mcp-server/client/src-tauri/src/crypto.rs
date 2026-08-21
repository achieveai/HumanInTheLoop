use aes_gcm::{
    aead::{Aead, OsRng},
    AeadCore, Aes256Gcm, Key, KeyInit, Nonce,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
pub struct EncryptedEnvelope {
    pub _encrypted: bool,
    pub iv: String,
    pub data: String,
}

/// Encrypt a plaintext string using AES-256-GCM.
/// Returns a JSON string: {"_encrypted":true,"iv":"<base64>","data":"<base64(ciphertext+tag)>"}
pub fn encrypt(plaintext: &str, key_hex: &str) -> Result<String, String> {
    let key_bytes = hex_to_bytes(key_hex)?;
    let key = Key::<Aes256Gcm>::from_slice(&key_bytes);
    let cipher = Aes256Gcm::new(key);

    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(&nonce, plaintext.as_bytes())
        .map_err(|e| format!("Encryption failed: {}", e))?;

    let envelope = EncryptedEnvelope {
        _encrypted: true,
        iv: BASE64.encode(nonce.as_slice()),
        data: BASE64.encode(&ciphertext),
    };

    serde_json::to_string(&envelope).map_err(|e| format!("JSON serialize failed: {}", e))
}

/// Decrypt from a pre-parsed serde_json::Value (avoids re-parsing).
pub fn decrypt_value(value: &serde_json::Value, key_hex: &str) -> Result<String, String> {
    let iv = value.get("iv").and_then(|v| v.as_str())
        .ok_or("Missing 'iv' field")?;
    let data = value.get("data").and_then(|v| v.as_str())
        .ok_or("Missing 'data' field")?;
    let envelope = EncryptedEnvelope {
        _encrypted: true,
        iv: iv.to_string(),
        data: data.to_string(),
    };
    decrypt_envelope(&envelope, key_hex)
}

fn decrypt_envelope(envelope: &EncryptedEnvelope, key_hex: &str) -> Result<String, String> {
    let key_bytes = hex_to_bytes(key_hex)?;
    let key = Key::<Aes256Gcm>::from_slice(&key_bytes);
    let cipher = Aes256Gcm::new(key);

    let iv_bytes = BASE64
        .decode(&envelope.iv)
        .map_err(|e| format!("Invalid IV base64: {}", e))?;
    let nonce = Nonce::from_slice(&iv_bytes);

    let ciphertext = BASE64
        .decode(&envelope.data)
        .map_err(|e| format!("Invalid data base64: {}", e))?;

    let plaintext = cipher
        .decrypt(nonce, ciphertext.as_ref())
        .map_err(|e| format!("Decryption failed (wrong key?): {}", e))?;

    String::from_utf8(plaintext).map_err(|e| format!("Invalid UTF-8: {}", e))
}

/// Check if a serde_json::Value is an encrypted envelope.
pub fn is_encrypted(value: &serde_json::Value) -> bool {
    value.get("_encrypted").and_then(|v| v.as_bool()) == Some(true)
        && value.get("iv").and_then(|v| v.as_str()).is_some()
        && value.get("data").and_then(|v| v.as_str()).is_some()
}

fn hex_to_bytes(hex: &str) -> Result<Vec<u8>, String> {
    if hex.len() != 64 {
        return Err(format!(
            "Encryption key must be 64 hex chars (256 bits), got {}",
            hex.len()
        ));
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).map_err(|e| format!("Invalid hex: {}", e)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

    fn parse(s: &str) -> serde_json::Value {
        serde_json::from_str(s).expect("envelope is json")
    }

    #[test]
    fn round_trips_plaintext() {
        let out = encrypt("hello world", KEY).expect("encrypts");
        assert_eq!(decrypt_value(&parse(&out), KEY).expect("decrypts"), "hello world");
    }

    #[test]
    fn round_trips_empty_plaintext() {
        let out = encrypt("", KEY).expect("encrypts");
        assert_eq!(decrypt_value(&parse(&out), KEY).expect("decrypts"), "");
    }

    #[test]
    fn round_trips_multibyte_plaintext() {
        let text = "héllo 🌍 — ünïcode";
        let out = encrypt(text, KEY).expect("encrypts");
        assert_eq!(decrypt_value(&parse(&out), KEY).expect("decrypts"), text);
    }

    #[test]
    fn two_encryptions_of_the_same_text_differ() {
        // A fresh nonce per call is the whole security property. If this ever
        // passes by equality, nonce generation has been broken.
        let a = encrypt("same", KEY).expect("encrypts");
        let b = encrypt("same", KEY).expect("encrypts");
        assert_ne!(a, b, "nonce must be fresh per encryption");
    }

    #[test]
    fn rejects_a_short_key() {
        assert!(encrypt("x", "00112233").is_err());
    }

    #[test]
    fn rejects_a_non_hex_key() {
        let bad = "zz112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
        assert!(encrypt("x", bad).is_err());
    }

    #[test]
    fn rejects_the_wrong_key_on_decrypt() {
        let other = "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100";
        let out = encrypt("secret", KEY).expect("encrypts");
        assert!(decrypt_value(&parse(&out), other).is_err());
    }

    #[test]
    fn rejects_a_tampered_ciphertext() {
        let out = encrypt("secret", KEY).expect("encrypts");
        let mut v = parse(&out);
        let data = v["data"].as_str().expect("data").to_string();
        let flipped = if data.starts_with('A') { format!("B{}", &data[1..]) }
                      else { format!("A{}", &data[1..]) };
        v["data"] = serde_json::Value::String(flipped);
        assert!(decrypt_value(&v, KEY).is_err(), "AEAD tag must reject tampering");
    }

    #[test]
    fn rejects_a_malformed_base64_iv() {
        let out = encrypt("secret", KEY).expect("encrypts");
        let mut v = parse(&out);
        v["iv"] = serde_json::Value::String("!!!not base64!!!".into());
        assert!(decrypt_value(&v, KEY).is_err());
    }

    #[test]
    fn is_encrypted_recognises_only_real_envelopes() {
        let out = encrypt("x", KEY).expect("encrypts");
        assert!(is_encrypted(&parse(&out)));
        assert!(!is_encrypted(&parse(r#"{"type":"question"}"#)));
        assert!(!is_encrypted(&parse(r#"{"_encrypted":true}"#)));
        assert!(!is_encrypted(&parse("null")));
    }
}
