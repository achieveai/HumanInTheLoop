import crypto from 'crypto';
import zlib from 'zlib';
import type { PlanPayloadRef } from './types.js';
import { shouldChunk, CHUNK_THRESHOLD_BYTES } from './chunking.js';
import { encrypt, decrypt } from './crypto.js';

/**
 * Payload pipeline for the four plan-review message types ONLY.
 *
 *   plaintext   = base64( gzip( JSON.stringify(bodyObject) ) )   // ASCII-safe string
 *   contentHash = sha256hex(plaintext)
 *   cipher      = encrypt(plaintext, key)                        // existing envelope JSON
 *   kind        = byteLength(cipher) <= PLAN_INLINE_THRESHOLD_BYTES ? 'inline' : 'attachment'
 *
 * The base64 layer exists precisely so the shipping string-in/string-out crypto
 * works unchanged on gzip binary. No new crypto lives here.
 *
 * The four shipping types (question / answer / notification /
 * dismiss_notification) must NOT go through this — they keep a byte-identical
 * wire format and stay wired to chunking.ts.
 */

/**
 * Ciphers at or under this size travel inline in the outer message; larger ones
 * become an ntfy attachment. Chosen so the whole outer message stays under
 * CHUNK_THRESHOLD_BYTES — a chunked plan_review would break the
 * one-ntfy-message-per-review guarantee (C-1).
 */
export const PLAN_INLINE_THRESHOLD_BYTES = 2048;

/**
 * Caps on what a payload may expand to.
 *
 * The content hash is no protection here: it is computed over the compressed
 * plaintext, which is exactly the bytes an attacker controls, so it confirms
 * "these are the bytes that were sent" and says nothing about what they
 * decompress to. Without a cap a 1 GiB expansion is a couple of seconds of
 * work for whoever holds the topic (H4).
 *
 * A plan is capped at 1 MB and a body carries the plan plus its diff, so 8 MB
 * is well clear of anything legitimate. The compressed cap is below ntfy's own
 * 2 MB attachment limit, so nothing that could arrive is rejected by it.
 */
export const PLAN_MAX_COMPRESSED_BYTES = 2 * 1024 * 1024;
export const PLAN_MAX_DECOMPRESSED_BYTES = 8 * 1024 * 1024;

/** Raised when a payload cannot be turned back into its body object. */
export class PayloadDecodeError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'PayloadDecodeError';
  }
}

/** Raised when an outer message would need chunking, which new types never do. */
export class PlanMessageTooLargeError extends Error {
  constructor(readonly byteLength: number) {
    super(
      `Plan message outer body is ${byteLength} bytes, over the ${CHUNK_THRESHOLD_BYTES}-byte ` +
        `single-message limit. Plan-review messages must never chunk (C-1).`
    );
    this.name = 'PlanMessageTooLargeError';
  }
}

/** The wire bytes plus the reference that describes them. */
export interface EncodedPayload {
  /**
   * Goes into the outer message's `body` field. `data` is populated only when
   * `kind === 'inline'`; for `'attachment'` the cipher travels as the PUT body
   * and the reader recovers it from the ntfy event's attachment URL.
   */
  ref: PlanPayloadRef;
  /**
   * The encrypted-envelope JSON string, or — when no encryption key is
   * configured — the bare base64(gzip(json)) plaintext.
   */
  cipher: string;
}

/** sha256 hex of a utf-8 string. */
export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Encode a plan-review body for the wire. */
export function encodePayload(body: unknown, keyHex?: string): EncodedPayload {
  const plaintext = zlib.gzipSync(Buffer.from(JSON.stringify(body), 'utf8')).toString('base64');
  const contentHash = sha256Hex(plaintext);
  const contentLength = Buffer.byteLength(plaintext, 'utf8');

  const cipher = keyHex ? encrypt(plaintext, keyHex) : plaintext;
  const inline = Buffer.byteLength(cipher, 'utf8') <= PLAN_INLINE_THRESHOLD_BYTES;

  return {
    ref: inline
      ? { kind: 'inline', data: cipher, contentHash, contentLength }
      : { kind: 'attachment', contentHash, contentLength },
    cipher,
  };
}

/**
 * Inverse of encodePayload. `cipher` is `ref.data` for an inline payload, or
 * the downloaded attachment bytes as a utf-8 string for an attachment one.
 * Throws PayloadDecodeError on a bad key, corrupt bytes, or a hash mismatch —
 * a mismatch must surface as a visible refusal, never a blank window (C-2).
 */
export function decodePayload<T>(cipher: string, keyHex: string | undefined, expectedHash: string): T {
  let plaintext: string;
  if (keyHex) {
    try {
      plaintext = decrypt(cipher, keyHex);
    } catch (err) {
      throw new PayloadDecodeError('Failed to decrypt plan payload', err);
    }
  } else {
    plaintext = cipher;
  }

  const actualHash = sha256Hex(plaintext);
  if (actualHash !== expectedHash) {
    throw new PayloadDecodeError(
      `Plan payload hash mismatch: expected ${expectedHash}, got ${actualHash}`
    );
  }

  let json: string;
  try {
    const compressed = Buffer.from(plaintext, 'base64');
    if (compressed.byteLength > PLAN_MAX_COMPRESSED_BYTES) {
      throw new PayloadDecodeError(
        `Plan payload is ${compressed.byteLength} compressed bytes, over the ` +
          `${PLAN_MAX_COMPRESSED_BYTES} limit`
      );
    }
    json = zlib
      .gunzipSync(compressed, { maxOutputLength: PLAN_MAX_DECOMPRESSED_BYTES })
      .toString('utf8');
  } catch (err) {
    if (err instanceof PayloadDecodeError) throw err;
    throw new PayloadDecodeError('Failed to gunzip plan payload', err);
  }

  try {
    return JSON.parse(json) as T;
  } catch (err) {
    throw new PayloadDecodeError('Plan payload is not valid JSON', err);
  }
}

/**
 * Guard for the publish path: a plan-review message must fit in one ntfy
 * message. Call this on the serialized outer body (post-encryption) before
 * publishing, and throw rather than silently falling back to chunking.
 */
export function assertNoChunk(outerBody: string): void {
  if (shouldChunk(outerBody)) {
    throw new PlanMessageTooLargeError(Buffer.byteLength(outerBody, 'utf8'));
  }
}
