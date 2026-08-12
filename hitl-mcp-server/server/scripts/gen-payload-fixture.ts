/**
 * Regenerates the cross-language payload fixture at `hitl-mcp-server/fixtures/plan-payload.json`.
 *
 * The fixture is produced by TypeScript and decoded by BOTH languages —
 * `server/src/__tests__/payload.test.ts` and the `mod tests` in
 * `client/src-tauri/src/payload.rs`. That is what pins the two payload
 * pipelines to the same wire format.
 *
 * Run:  npm run fixture:payload   (from hitl-mcp-server/server)
 *
 * The bodies are generated from a fixed-seed LCG, so the only thing that
 * changes between runs is the AES-GCM IV.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { encodePayload } from '../src/payload.js';
import type { PlanReviewBody, PlanReviewResponseBody } from '../src/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.resolve(HERE, '../../fixtures/plan-payload.json');

/** Fixed 256-bit key. Test-only — never a real key. */
const ENCRYPTION_KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

/** Deterministic pseudo-random words, so regeneration is stable. */
function lorem(wordCount: number): string {
  const words = ['plan', 'review', 'anchor', 'revision', 'diff', 'snapshot', 'verdict',
    'comment', 'line', 'payload', 'gzip', 'envelope', 'topic', 'client', 'server'];
  let seed = 0x2545f491;
  const out: string[] = [];
  for (let i = 0; i < wordCount; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out.push(words[seed % words.length]!);
  }
  return out.join(' ');
}

const inlineBody: PlanReviewBody = {
  content: '# Plan\n\nLine one.\nLine two.\n',
  diff: '--- a/plan.md\n+++ b/plan.md\n@@ -1,2 +1,3 @@\n # Plan\n+Line two.\n',
};

/** Large enough that the cipher lands over PLAN_INLINE_THRESHOLD_BYTES. */
const attachmentBody: PlanReviewBody = {
  content: `# Big plan\r\n\r\n${lorem(4000)}\r\n`,
  diff: `--- a/plan.md\n+++ b/plan.md\n@@ -1,1 +1,1 @@\n-old\n+${lorem(2000)}\n`,
};

const responseBody: PlanReviewResponseBody = {
  overallFeedback: 'Mostly good. Two notes inline.',
  inlineComments: [
    { path: 'plan.md', startLine: 1, endLine: 1, side: 'new', comment: 'Title is fine.' },
    { path: 'plan.md', startLine: 2, endLine: 4, side: 'new', comment: 'Widen this range.' },
    { path: 'plan.md', startLine: 3, endLine: 3, side: 'old', comment: 'Why was this dropped?' },
  ],
};

const inline = encodePayload(inlineBody, ENCRYPTION_KEY);
const attachment = encodePayload(attachmentBody, ENCRYPTION_KEY);
const response = encodePayload(responseBody, ENCRYPTION_KEY);
const unencrypted = encodePayload(inlineBody, undefined);

if (inline.ref.kind !== 'inline') throw new Error('inline case did not stay inline');
if (attachment.ref.kind !== 'attachment') throw new Error('attachment case did not spill');

const fixture = {
  _comment:
    'Cross-language payload fixture. Produced by TypeScript (server/scripts/gen-payload-fixture.ts), ' +
    'decoded by both server/src/__tests__/payload.test.ts and client/src-tauri/src/payload.rs. ' +
    'Regenerate with: npm run fixture:payload',
  encryptionKey: ENCRYPTION_KEY,
  cases: [
    { name: 'inline-plan-review-body', encrypted: true, body: inlineBody, ref: inline.ref, cipher: inline.cipher },
    { name: 'attachment-plan-review-body', encrypted: true, body: attachmentBody, ref: attachment.ref, cipher: attachment.cipher },
    { name: 'inline-plan-review-response-body', encrypted: true, body: responseBody, ref: response.ref, cipher: response.cipher },
    { name: 'inline-unencrypted', encrypted: false, body: inlineBody, ref: unencrypted.ref, cipher: unencrypted.cipher },
  ],
};

fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
fs.writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
console.log(`Wrote ${FIXTURE_PATH}`);
