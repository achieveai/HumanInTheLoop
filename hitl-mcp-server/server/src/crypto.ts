import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;   // 12 bytes is standard for GCM
const TAG_LENGTH = 16;  // 16 bytes auth tag
const KEY_HEX_LENGTH = 64; // 64 hex chars = 32 bytes = 256 bits

function validateKeyHex(keyHex: string): Buffer {
  if (keyHex.length !== KEY_HEX_LENGTH) {
    throw new Error(`Encryption key must be ${KEY_HEX_LENGTH} hex chars (256 bits), got ${keyHex.length}`);
  }
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) {
    throw new Error(`Encryption key contains invalid hex characters`);
  }
  return key;
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns a JSON string: {"_encrypted":true,"iv":"<base64>","data":"<base64(ciphertext+tag)>"}
 */
export function encrypt(plaintext: string, keyHex: string): string {
  const key = validateKeyHex(keyHex);
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Append tag to ciphertext (matches Rust aes-gcm convention)
  const dataWithTag = Buffer.concat([ciphertext, tag]);

  return JSON.stringify({
    _encrypted: true,
    iv: iv.toString('base64'),
    data: dataWithTag.toString('base64'),
  });
}

/**
 * Decrypt an encrypted envelope string using AES-256-GCM.
 * Input is the JSON string produced by encrypt().
 * Returns the original plaintext.
 */
export function decrypt(envelopeJson: string, keyHex: string): string {
  const envelope = JSON.parse(envelopeJson);
  if (!envelope._encrypted) {
    throw new Error('Not an encrypted envelope');
  }

  const key = validateKeyHex(keyHex);
  const iv = Buffer.from(envelope.iv, 'base64');
  const dataWithTag = Buffer.from(envelope.data, 'base64');

  // Split: last 16 bytes are the auth tag, rest is ciphertext
  const ciphertext = dataWithTag.subarray(0, dataWithTag.length - TAG_LENGTH);
  const tag = dataWithTag.subarray(dataWithTag.length - TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

/**
 * Check if a parsed JSON object is an encrypted envelope.
 */
export function isEncryptedEnvelope(parsed: unknown): boolean {
  return (
    typeof parsed === 'object' &&
    parsed !== null &&
    (parsed as Record<string, unknown>)._encrypted === true &&
    typeof (parsed as Record<string, unknown>).iv === 'string' &&
    typeof (parsed as Record<string, unknown>).data === 'string'
  );
}
