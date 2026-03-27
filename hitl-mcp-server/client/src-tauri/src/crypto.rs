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
