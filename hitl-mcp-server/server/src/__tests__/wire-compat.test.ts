import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { randomBytes } from 'crypto';
import { NtfyTransport } from '../ntfy-transport.js';
import { decrypt, isEncryptedEnvelope } from '../crypto.js';
import type { QuestionMessage, NotificationMessage, HitlConfig } from '../types.js';

/**
 * Non-negotiable #1: the four shipping message types keep a BYTE-IDENTICAL wire
 * format. A new server publishing a changed shape to an already-installed
 * client decrypts fine, fails every parse, and falls through the client's
 * dispatch — no window, no log. With timeouts removed the agent then hangs
 * forever, and it would hit ordinary AskUserQuestion calls, not just plans.
 *
 * So: no protocolVersion in their emitted JSON, no gzip, no re-encoding.
 *
 * Scope: only `question` and `notification` are covered here, because those are
 * the only two of the four this server publishes. `answer` and
 * `dismiss_notification` travel the other way — the Rust client publishes them
 * and this server only parses them — so their emitted bytes are pinned on the
 * client side (`client/src-tauri/src/types.rs`), not here.
 */
const CONFIG: HitlConfig = {
  topicId: 'topic-under-test',
  ntfyUrl: 'https://ntfy.sh',
  deviceName: 'test-device',
  soundEnabled: false,
};

/**
 * The exact bytes v2.9.6 put on the topic for the two messages below.
 *
 * Checked in as raw strings on purpose. Deriving the expectation from the TS
 * types instead — `expect(body).toBe(JSON.stringify(QUESTION))` — proves only
 * that `publish` did not re-encode; add a field to `QuestionMessage` and to the
 * fixture and both sides move together while every installed client breaks.
 * A literal cannot move.
 *
 * Verified against v2.9.6 (commit e091198): the shipping interfaces in
 * `types.ts` and the body of `NtfyTransport.publish` are unchanged since that
 * tag, so today's emitted bytes are that release's emitted bytes.
 */
const GOLDEN_QUESTION =
  '{"type":"question","messageId":"21ba33d7-08a8-4761-9abf-5f4e6ba364b1","timestamp":1700000000000,' +
  '"repo":null,"context":"ctx","question":"Proceed?","options":[{"label":"Yes","value":"yes"}],' +
  '"allowMultiple":false,"allowOther":true}';

const GOLDEN_NOTIFICATION =
  '{"type":"notification","messageId":"31ba33d7-08a8-4761-9abf-5f4e6ba364b2","timestamp":1700000000000,' +
  '"title":"Build complete","body":"All green."}';

/**
 * The same two messages as typed literals. These carry the other half of the
 * guarantee: adding a required field to `QuestionMessage` fails to compile
 * here, and adding an optional one fails the byte comparison above.
 */
const QUESTION: QuestionMessage = {
  type: 'question',
  messageId: '21ba33d7-08a8-4761-9abf-5f4e6ba364b1',
  timestamp: 1_700_000_000_000,
  repo: null,
  context: 'ctx',
  question: 'Proceed?',
  options: [{ label: 'Yes', value: 'yes' }],
  allowMultiple: false,
  allowOther: true,
};

const NOTIFICATION: NotificationMessage = {
  type: 'notification',
  messageId: '31ba33d7-08a8-4761-9abf-5f4e6ba364b2',
  timestamp: 1_700_000_000_000,
  title: 'Build complete',
  body: 'All green.',
};

describe('shipping message wire format', () => {
  const realFetch = globalThis.fetch;
  let bodies: string[];

  beforeEach(() => {
    bodies = [];
    globalThis.fetch = jest.fn(async (_url: unknown, init: unknown) => {
      bodies.push((init as { body: string }).body);
      return { ok: true, status: 200, statusText: 'OK' } as Response;
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('publishes a question as the bytes v2.9.6 published', async () => {
    await new NtfyTransport(CONFIG).publish(QUESTION);

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toBe(GOLDEN_QUESTION);
  });

  it('publishes a notification as the bytes v2.9.6 published', async () => {
    await new NtfyTransport(CONFIG).publish(NOTIFICATION);

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toBe(GOLDEN_NOTIFICATION);
  });

  it('emits no protocolVersion field for the shipping types', async () => {
    const transport = new NtfyTransport(CONFIG);
    await transport.publish(QUESTION);
    await transport.publish(NOTIFICATION);

    for (const body of bodies) {
      expect(body).not.toContain('protocolVersion');
      expect(JSON.parse(body).protocolVersion).toBeUndefined();
    }
  });

  it('wraps the same golden bytes, unaltered, when a key is configured', async () => {
    // The encrypted branch is the one that actually ships: the client refuses
    // to run without a key. Whatever the envelope looks like, what it must
    // contain is the plaintext above and nothing else — a gzip or a re-encode
    // hidden inside encryption breaks the installed client just as completely,
    // and the ciphertext makes it invisible to the plaintext assertions.
    const encryptionKey = randomBytes(32).toString('hex');
    await new NtfyTransport({ ...CONFIG, encryptionKey }).publish(QUESTION);

    expect(bodies).toHaveLength(1);
    expect(decrypt(bodies[0], encryptionKey)).toBe(GOLDEN_QUESTION);

    // The envelope shape the Rust client deserializes. serde ignores key order,
    // so the key set is the contract, not the ordering.
    const envelope = JSON.parse(bodies[0]) as Record<string, unknown>;
    expect(isEncryptedEnvelope(envelope)).toBe(true);
    expect(Object.keys(envelope).sort()).toEqual(['_encrypted', 'data', 'iv']);
  });

  it('still chunks an oversized shipping message rather than dropping it', async () => {
    const huge: QuestionMessage = { ...QUESTION, question: 'q'.repeat(9000) };
    await new NtfyTransport(CONFIG).publish(huge);

    expect(bodies.length).toBeGreaterThan(1);
    for (const body of bodies) {
      expect(JSON.parse(body).type).toBe('chunk');
      expect(JSON.parse(body).groupId).toBe(huge.messageId);
    }
  });
});
