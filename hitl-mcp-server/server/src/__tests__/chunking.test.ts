import { describe, it, expect } from '@jest/globals';
import {
  shouldChunk,
  splitIntoChunks,
  CHUNK_THRESHOLD_BYTES,
  CHUNK_DATA_SIZE,
} from '../chunking.js';

describe('chunking', () => {
  describe('shouldChunk', () => {
    it('returns false for a body under the threshold', () => {
      expect(shouldChunk('a'.repeat(CHUNK_THRESHOLD_BYTES - 1))).toBe(false);
    });

    it('returns false for a body exactly at the threshold', () => {
      expect(shouldChunk('a'.repeat(CHUNK_THRESHOLD_BYTES))).toBe(false);
    });

    it('returns true for a body one byte over the threshold', () => {
      expect(shouldChunk('a'.repeat(CHUNK_THRESHOLD_BYTES + 1))).toBe(true);
    });

    it('accounts for multi-byte UTF-8 characters when measuring size', () => {
      // Each '€' is 3 bytes in UTF-8 but 1 UTF-16 code unit.
      const body = '€'.repeat(Math.ceil((CHUNK_THRESHOLD_BYTES + 1) / 3));
      expect(shouldChunk(body)).toBe(true);
    });
  });

  describe('splitIntoChunks', () => {
    function reassemble(chunks: ReturnType<typeof splitIntoChunks>): string {
      const sorted = [...chunks].sort((a, b) => a.index - b.index);
      const encoded = sorted.map((c) => c.data).join('');
      return Buffer.from(encoded, 'base64').toString('utf8');
    }

    it('round-trips a body that requires multiple chunks', () => {
      const body = JSON.stringify({ text: 'x'.repeat(10_000) });
      const chunks = splitIntoChunks(body, 'group-1');

      expect(chunks.length).toBeGreaterThan(1);
      expect(reassemble(chunks)).toBe(body);
    });

    it('produces chunks with correct type, groupId, index and total', () => {
      const body = 'y'.repeat(10_000);
      const chunks = splitIntoChunks(body, 'group-2');

      expect(chunks.every((c) => c.type === 'chunk')).toBe(true);
      expect(chunks.every((c) => c.groupId === 'group-2')).toBe(true);
      expect(chunks.every((c) => c.total === chunks.length)).toBe(true);
      expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
    });

    it('round-trips a body whose base64 length is an exact multiple of CHUNK_DATA_SIZE', () => {
      // Pick a plaintext length whose base64 encoding lands exactly on a chunk boundary.
      const encodedLength = CHUNK_DATA_SIZE * 3;
      const plaintextLength = Math.floor((encodedLength / 4) * 3);
      const body = 'z'.repeat(plaintextLength);
      const chunks = splitIntoChunks(body, 'group-3');

      expect(reassemble(chunks)).toBe(body);
    });

    it('round-trips a body one byte larger than an exact chunk-size multiple', () => {
      const encodedLength = CHUNK_DATA_SIZE * 2;
      const plaintextLength = Math.floor((encodedLength / 4) * 3) + 1;
      const body = 'w'.repeat(plaintextLength);
      const chunks = splitIntoChunks(body, 'group-4');

      expect(reassemble(chunks)).toBe(body);
    });

    it('round-trips a body containing multi-byte UTF-8 characters', () => {
      const body = JSON.stringify({ text: '日本語のテキスト🎉'.repeat(1000) });
      const chunks = splitIntoChunks(body, 'group-5');

      expect(reassemble(chunks)).toBe(body);
    });
  });
});
