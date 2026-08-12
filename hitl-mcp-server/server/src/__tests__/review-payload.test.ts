import { describe, it, expect } from '@jest/globals';
import { randomBytes } from 'crypto';
import zlib from 'zlib';
import type { InlineComment, PlanReviewResponseBody, PlanReviewBody } from '../types.js';
import {
  encodePayload,
  decodePayload,
  sha256Hex,
  PayloadDecodeError,
  PLAN_INLINE_THRESHOLD_BYTES,
  PLAN_MAX_DECOMPRESSED_BYTES,
} from '../payload.js';
import { encrypt } from '../crypto.js';
import {
  normalizeInlineComments,
  normalizeResponseBody,
  parseVerdict,
  ReviewResponseError,
} from '../plan-review.js';

const KEY = randomBytes(32).toString('hex');
const PLAN_PATH = 'docs/plan.md';

function comment(startLine: number, text: string, over: Partial<InlineComment> = {}): InlineComment {
  return { path: PLAN_PATH, startLine, endLine: startLine, side: 'new', comment: text, ...over };
}

/** Deterministic shuffle so a failure is reproducible. */
function rotate<T>(items: T[], by: number): T[] {
  return [...items.slice(by), ...items.slice(0, by)];
}

describe('review response payload', () => {
  it('round-trips 30 inline comments plus a >4 KB paragraph (C-5)', () => {
    const inlineComments = Array.from({ length: 30 }, (_, i) =>
      comment(i * 3 + 1, `Comment number ${i} about this range.`, { endLine: i * 3 + 3 })
    );
    const overallFeedback = 'The dependency order is wrong. '.repeat(150);
    expect(Buffer.byteLength(overallFeedback, 'utf8')).toBeGreaterThan(4096);

    const body: PlanReviewResponseBody = { overallFeedback, inlineComments };
    const encoded = encodePayload(body, KEY);

    const decoded = decodePayload<PlanReviewResponseBody>(encoded.cipher, KEY, encoded.ref.contentHash);
    expect(decoded).toEqual(body);
    expect(decoded.overallFeedback).toHaveLength(overallFeedback.length);
    expect(decoded.inlineComments).toHaveLength(30);
  });

  it('spills to an attachment once the cipher passes the threshold', () => {
    // Prose that long compresses to almost nothing, so pin the kind flip with
    // content gzip cannot shrink.
    const body: PlanReviewResponseBody = {
      overallFeedback: randomBytes(8192).toString('base64'),
      inlineComments: [comment(1, 'see above')],
    };
    const encoded = encodePayload(body, KEY);

    expect(encoded.ref.kind).toBe('attachment');
    expect(encoded.ref.data).toBeUndefined();
    expect(decodePayload<PlanReviewResponseBody>(encoded.cipher, KEY, encoded.ref.contentHash)).toEqual(
      body
    );
  });

  it('keeps a small response inline', () => {
    const encoded = encodePayload({ overallFeedback: 'Looks good.', inlineComments: [] }, KEY);

    expect(encoded.ref.kind).toBe('inline');
    expect(Buffer.byteLength(encoded.ref.data ?? '', 'utf8')).toBeLessThanOrEqual(
      PLAN_INLINE_THRESHOLD_BYTES
    );
  });

  it('round-trips a plan body with CRLF and unicode intact', () => {
    const body: PlanReviewBody = {
      content: '# Plan\r\n\r\n- é\r\n- 中文\r\n',
      diff: '--- a/docs/plan.md\n+++ b/docs/plan.md\n@@ -0,0 +1,4 @@\n+# Plan\r\n',
    };
    const encoded = encodePayload(body, KEY);

    expect(decodePayload<PlanReviewBody>(encoded.cipher, KEY, encoded.ref.contentHash)).toEqual(body);
  });

  it('refuses a payload that expands past the decompressed cap (H4)', () => {
    // Whoever holds the topic can put anything on it. The content hash covers
    // the compressed bytes, so it confirms nothing about what they expand to:
    // 32 KB on the wire becomes 64 MB of resident heap without a cap.
    const bomb = zlib.gzipSync(Buffer.alloc(PLAN_MAX_DECOMPRESSED_BYTES * 8)).toString('base64');
    expect(Buffer.byteLength(bomb, 'utf8')).toBeLessThan(200_000);

    const cipher = encrypt(bomb, KEY);
    expect(() => decodePayload(cipher, KEY, sha256Hex(bomb))).toThrow(PayloadDecodeError);
  });

  it('names the compressed size when the payload is too big to even try (H4)', () => {
    // Incompressible bytes over the compressed cap are rejected before gunzip,
    // so the process never allocates the output buffer at all.
    const oversized = randomBytes(3 * 1024 * 1024).toString('base64');

    expect(() => decodePayload(encrypt(oversized, KEY), KEY, sha256Hex(oversized))).toThrow(
      /compressed bytes, over the/
    );
  });
});

describe('normalizeInlineComments', () => {
  it('serializes byte-identically regardless of click order (A-4)', () => {
    const comments = [
      comment(42, 'This assumes the migration already ran.', { endLine: 47 }),
      comment(42, 'Also: name the owner.', { endLine: 47 }),
      comment(9, 'Typo.'),
      comment(9, 'Typo.', { side: 'old' }),
      comment(120, 'Wrong order.'),
      comment(9, 'Second thought on line 9.'),
    ];

    const baseline = JSON.stringify(normalizeInlineComments(comments, PLAN_PATH));

    for (let by = 1; by < comments.length; by++) {
      expect(JSON.stringify(normalizeInlineComments(rotate(comments, by), PLAN_PATH))).toBe(baseline);
    }
    expect(JSON.stringify(normalizeInlineComments([...comments].reverse(), PLAN_PATH))).toBe(baseline);
  });

  it('orders by path, then start, then end, then side, then text', () => {
    const sorted = normalizeInlineComments(
      [
        comment(10, 'b'),
        comment(10, 'a'),
        comment(10, 'a', { side: 'old' }),
        comment(10, 'a', { endLine: 12 }),
        comment(2, 'first'),
        comment(10, 'z', { path: 'other.md' }),
      ],
      PLAN_PATH
    );

    expect(sorted.map((c) => [c.path, c.startLine, c.endLine, c.side, c.comment])).toEqual([
      [PLAN_PATH, 2, 2, 'new', 'first'],
      [PLAN_PATH, 10, 10, 'new', 'a'],
      [PLAN_PATH, 10, 10, 'new', 'b'],
      [PLAN_PATH, 10, 10, 'old', 'a'],
      [PLAN_PATH, 10, 12, 'new', 'a'],
      ['other.md', 10, 10, 'new', 'z'],
    ]);
  });

  it('orders by code point, not by locale, so NFC and NFD stay distinct (M3)', () => {
    // The same accented word as macOS composes it and as Windows decomposes it.
    // localeCompare calls these equal, which makes the sort order depend on
    // input order — and A-4 requires the same bytes on every device.
    const nfc = 'café';
    const nfd = 'café';
    expect(nfc.localeCompare(nfd)).toBe(0);
    expect(nfc).not.toBe(nfd);

    const comments = [comment(1, nfd), comment(1, nfc), comment(1, 'apple')];
    const forward = JSON.stringify(normalizeInlineComments(comments, PLAN_PATH));
    const reversed = JSON.stringify(normalizeInlineComments([...comments].reverse(), PLAN_PATH));

    expect(forward).toBe(reversed);
    // 'e' (U+0065) sorts before 'é' (U+00E9), so the decomposed form comes first.
    expect(normalizeInlineComments(comments, PLAN_PATH).map((c) => c.comment)).toEqual([
      'apple',
      nfd,
      nfc,
    ]);
  });

  it('trims text and drops comments that are empty after trimming', () => {
    const sorted = normalizeInlineComments(
      [comment(1, '   spaced   '), comment(2, '   '), comment(3, '')],
      PLAN_PATH
    );

    expect(sorted).toEqual([comment(1, 'spaced')]);
  });

  it('repairs anchors rather than trusting whatever the client sent', () => {
    const sorted = normalizeInlineComments(
      [
        { path: '', startLine: 0, endLine: -5, side: 'sideways', comment: 'x' },
        { startLine: 8.7, endLine: 3, comment: 'y' },
      ] as unknown[],
      PLAN_PATH
    );

    expect(sorted).toEqual([
      { path: PLAN_PATH, startLine: 1, endLine: 1, side: 'new', comment: 'x' },
      { path: PLAN_PATH, startLine: 8, endLine: 8, side: 'new', comment: 'y' },
    ]);
  });

  it('ignores a non-array and non-object entries', () => {
    expect(normalizeInlineComments(undefined, PLAN_PATH)).toEqual([]);
    expect(normalizeInlineComments('nope', PLAN_PATH)).toEqual([]);
    expect(normalizeInlineComments([null, 42, 'x'], PLAN_PATH)).toEqual([]);
  });
});

describe('normalizeResponseBody', () => {
  it('rejects changes_requested with no feedback and no comments (A-5)', () => {
    expect(() =>
      normalizeResponseBody('changes_requested', { overallFeedback: '  ', inlineComments: [] }, PLAN_PATH)
    ).toThrow(ReviewResponseError);
  });

  it('rejects rejected with only whitespace comments (A-5)', () => {
    expect(() =>
      normalizeResponseBody(
        'rejected',
        { overallFeedback: '', inlineComments: [comment(1, '   ')] },
        PLAN_PATH
      )
    ).toThrow(/requires either overall feedback/);
  });

  it('accepts changes_requested carrying only inline comments', () => {
    const body = normalizeResponseBody(
      'changes_requested',
      { overallFeedback: '', inlineComments: [comment(4, 'Fix this.')] },
      PLAN_PATH
    );

    expect(body.overallFeedback).toBe('');
    expect(body.inlineComments).toHaveLength(1);
  });

  it('accepts changes_requested carrying only overall feedback', () => {
    expect(
      normalizeResponseBody('changes_requested', { overallFeedback: 'Redo section 3.' }, PLAN_PATH)
        .overallFeedback
    ).toBe('Redo section 3.');
  });

  it('accepts an approval with nothing attached', () => {
    expect(normalizeResponseBody('approved', {}, PLAN_PATH)).toEqual({
      overallFeedback: '',
      inlineComments: [],
    });
  });

  it('accepts skipped and cancelled with nothing attached', () => {
    for (const verdict of ['skipped', 'cancelled'] as const) {
      expect(normalizeResponseBody(verdict, {}, PLAN_PATH).inlineComments).toEqual([]);
    }
  });

  it('survives a body that is not an object at all', () => {
    expect(normalizeResponseBody('approved', null, PLAN_PATH)).toEqual({
      overallFeedback: '',
      inlineComments: [],
    });
  });
});

describe('parseVerdict', () => {
  it('passes through every valid verdict', () => {
    for (const v of ['approved', 'changes_requested', 'rejected', 'skipped', 'cancelled'] as const) {
      expect(parseVerdict(v)).toBe(v);
    }
  });

  it('refuses an unknown verdict instead of calling it skipped (M1)', () => {
    // Coercing to 'skipped' told the agent the human declined when in fact a
    // client sent something this server does not understand — and it routed
    // around the A-5 gate, since 'skipped' needs no feedback.
    expect(() => parseVerdict('lgtm')).toThrow(ReviewResponseError);
    expect(() => parseVerdict(undefined)).toThrow(/expected one of/);
    expect(() => parseVerdict(7)).toThrow(ReviewResponseError);
  });
});
