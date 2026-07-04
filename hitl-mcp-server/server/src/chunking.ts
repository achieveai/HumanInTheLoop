import type { ChunkMessage } from './types.js';

/** ntfy's documented per-message size cap. */
export const NTFY_LIMIT_BYTES = 4096;

/** Bodies at/under this size publish unchanged as a single message. */
export const CHUNK_THRESHOLD_BYTES = 3900;

/** base64 chars per chunk's `data` field. */
export const CHUNK_DATA_SIZE = 3000;

/** Whether a serialized message body needs to be split before publishing. */
export function shouldChunk(body: string): boolean {
  return Buffer.byteLength(body, 'utf8') > CHUNK_THRESHOLD_BYTES;
}

/**
 * Split an oversized body into ordered chunk fragments.
 * The body is base64-encoded first so slicing is always ASCII-safe — it can
 * never cut a multi-byte UTF-8 character in half, regardless of whether the
 * body is already an encrypted (base64) envelope or plain JSON text.
 */
export function splitIntoChunks(body: string, groupId: string): ChunkMessage[] {
  const encoded = Buffer.from(body, 'utf8').toString('base64');
  const total = Math.ceil(encoded.length / CHUNK_DATA_SIZE);
  const timestamp = Date.now();

  const chunks: ChunkMessage[] = [];
  for (let index = 0; index < total; index++) {
    chunks.push({
      type: 'chunk',
      messageId: `${groupId}-chunk-${index}`,
      timestamp,
      groupId,
      index,
      total,
      data: encoded.slice(index * CHUNK_DATA_SIZE, (index + 1) * CHUNK_DATA_SIZE),
    });
  }
  return chunks;
}
