import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  encodePayload,
  decodePayload,
  assertNoChunk,
  sha256Hex,
  PayloadDecodeError,
  PlanMessageTooLargeError,
  PLAN_INLINE_THRESHOLD_BYTES,
} from '../payload.js';
import { CHUNK_THRESHOLD_BYTES } from '../chunking.js';
import type { PlanReviewBody, PlanReviewMessage } from '../types.js';
import { PROTOCOL_VERSION } from '../types.js';

const KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const OTHER_KEY = 'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.resolve(HERE, '../../../fixtures/plan-payload.json');

/** Body whose gzip is large enough to push the cipher over the inline threshold. */
function bigBody(): PlanReviewBody {
  const words = ['plan', 'review', 'anchor', 'revision', 'diff', 'snapshot', 'verdict'];
  let seed = 7;
  const out: string[] = [];
  for (let i = 0; i < 4000; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out.push(words[seed % words.length]!);
  }
  return { content: out.join(' '), diff: out.slice(0, 1000).join('\n') };
}

describe('payload encode/decode', () => {
  it('round-trips a body through gzip, base64 and encryption', () => {
    const body: PlanReviewBody = { content: '# Plan\n\nhello\n', diff: '@@ -0,0 +1 @@\n+hello\n' };
    const { ref, cipher } = encodePayload(body, KEY);

    expect(decodePayload<PlanReviewBody>(cipher, KEY, ref.contentHash)).toEqual(body);
  });

  it('round-trips with no encryption key configured', () => {
    const body: PlanReviewBody = { content: 'plain', diff: '' };
    const { ref, cipher } = encodePayload(body, undefined);

    expect(decodePayload<PlanReviewBody>(cipher, undefined, ref.contentHash)).toEqual(body);
  });

  it('preserves CRLF and lone-CR line endings verbatim', () => {
    const body: PlanReviewBody = { content: 'a\r\nb\rc\nd', diff: '' };
    const { ref, cipher } = encodePayload(body, KEY);

    expect(decodePayload<PlanReviewBody>(cipher, KEY, ref.contentHash).content).toBe('a\r\nb\rc\nd');
  });

  it('keeps a small body inline and carries the cipher in ref.data', () => {
    const { ref, cipher } = encodePayload({ content: 'tiny', diff: '' }, KEY);

    expect(ref.kind).toBe('inline');
    expect(ref.data).toBe(cipher);
    expect(Buffer.byteLength(cipher, 'utf8')).toBeLessThanOrEqual(PLAN_INLINE_THRESHOLD_BYTES);
  });

  it('flips to attachment past the threshold and omits ref.data', () => {
    const { ref, cipher } = encodePayload(bigBody(), KEY);

    expect(ref.kind).toBe('attachment');
    expect(ref.data).toBeUndefined();
    expect(Buffer.byteLength(cipher, 'utf8')).toBeGreaterThan(PLAN_INLINE_THRESHOLD_BYTES);
    // The cipher is still decodable — it just travels as the attachment body.
    expect(decodePayload<PlanReviewBody>(cipher, KEY, ref.contentHash)).toEqual(bigBody());
  });

  it('reports contentHash over the plaintext and contentLength in bytes', () => {
    const { ref, cipher } = encodePayload({ content: 'x', diff: '' }, undefined);

    // With no key the cipher IS the plaintext, so the hash must match it directly.
    expect(ref.contentHash).toBe(sha256Hex(cipher));
    expect(ref.contentLength).toBe(Buffer.byteLength(cipher, 'utf8'));
    expect(ref.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('throws on corrupted ciphertext rather than returning a blank body', () => {
    const { ref, cipher } = encodePayload({ content: 'secret', diff: '' }, KEY);
    const envelope = JSON.parse(cipher);
    envelope.data = Buffer.from('garbage-garbage-garbage-garbage-').toString('base64');

    expect(() => decodePayload(JSON.stringify(envelope), KEY, ref.contentHash)).toThrow(PayloadDecodeError);
  });

  it('throws when decrypted with the wrong key', () => {
    const { ref, cipher } = encodePayload({ content: 'secret', diff: '' }, KEY);

    expect(() => decodePayload(cipher, OTHER_KEY, ref.contentHash)).toThrow(PayloadDecodeError);
  });

  it('throws on a hash mismatch', () => {
    const { cipher } = encodePayload({ content: 'secret', diff: '' }, KEY);
    const wrongHash = '0'.repeat(64);

    expect(() => decodePayload(cipher, KEY, wrongHash)).toThrow(/hash mismatch/);
  });

  it('throws when the plaintext is not valid gzip', () => {
    const notGzip = Buffer.from('definitely not gzip', 'utf8').toString('base64');

    expect(() => decodePayload(notGzip, undefined, sha256Hex(notGzip))).toThrow(/gunzip/);
  });
});

describe('assertNoChunk', () => {
  it('accepts an outer plan_review message carrying an inline payload', () => {
    const { ref } = encodePayload({ content: 'x'.repeat(400), diff: 'y'.repeat(400) }, KEY);
    expect(ref.kind).toBe('inline');

    const outer: PlanReviewMessage = {
      type: 'plan_review',
      messageId: '11111111-2222-3333-4444-555555555555',
      timestamp: 1_700_000_000_000,
      protocolVersion: PROTOCOL_VERSION,
      repo: { name: 'HumanInTheLoop', branch: 'master' },
      context: 'Reviewing the S0 contract gate',
      summary: 'Adds the plan-review message types',
      displayPath: 'docs/plan.md',
      planId: 'a'.repeat(64),
      revision: 2,
      isNewPlan: false,
      snapshotHash: `sha256:${'b'.repeat(64)}`,
      body: ref,
    };

    const serialized = JSON.stringify(outer);
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(CHUNK_THRESHOLD_BYTES);
    expect(() => assertNoChunk(serialized)).not.toThrow();
    // Single-line, so it is also legal in the X-Message header of an attachment PUT.
    expect(serialized).not.toMatch(/[\r\n]/);
  });

  it('throws rather than silently chunking an oversized outer message', () => {
    expect(() => assertNoChunk('z'.repeat(CHUNK_THRESHOLD_BYTES + 1))).toThrow(PlanMessageTooLargeError);
  });
});

describe('cross-language fixture', () => {
  interface FixtureCase {
    name: string;
    encrypted: boolean;
    body: unknown;
    ref: { kind: string; data?: string; contentHash: string; contentLength: number };
    cipher: string;
  }
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')) as {
    encryptionKey: string;
    cases: FixtureCase[];
  };

  it('has the checked-in cases the Rust side also decodes', () => {
    expect(fixture.cases.map((c) => c.name)).toEqual([
      'inline-plan-review-body',
      'attachment-plan-review-body',
      'inline-plan-review-response-body',
      'inline-unencrypted',
    ]);
  });

  it.each([0, 1, 2, 3])('decodes fixture case %i', (index) => {
    const c = fixture.cases[index]!;
    const key = c.encrypted ? fixture.encryptionKey : undefined;

    expect(decodePayload(c.cipher, key, c.ref.contentHash)).toEqual(c.body);
    expect(c.ref.contentLength).toBeGreaterThan(0);
    if (c.ref.kind === 'inline') {
      expect(c.ref.data).toBe(c.cipher);
    } else {
      expect(c.ref.data).toBeUndefined();
    }
  });
});
