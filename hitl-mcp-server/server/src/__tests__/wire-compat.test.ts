import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { randomBytes } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { NtfyTransport } from '../ntfy-transport.js';
import { HumanInTheLoopServer } from '../mcp-server.js';
import { decrypt, isEncryptedEnvelope } from '../crypto.js';
import type {
  QuestionMessage,
  AnswerMessage,
  NotificationMessage,
  DismissNotificationMessage,
  HitlMessage,
  HitlConfig,
} from '../types.js';

/**
 * Non-negotiable #1: the four shipping message types keep a BYTE-IDENTICAL wire
 * format. A new server publishing a changed shape to an already-installed
 * client decrypts fine, fails every parse, and falls through the client's
 * dispatch — no window, no log. With timeouts removed the agent then hangs
 * forever, and it would hit ordinary AskUserQuestion calls, not just plans.
 *
 * So: no protocolVersion in their emitted JSON, no gzip, no re-encoding.
 *
 * `answer` and `dismiss_notification` travel the other way in production — the
 * Rust client publishes them and this server only parses them. They are still
 * published through `NtfyTransport.publish` here, because what this file guards
 * is that `publish` is transparent for every member of the `HitlMessage` union,
 * not just the two the server happens to send.
 *
 * Their *emitted* bytes are not pinned anywhere. `types.rs` pins how all four
 * shapes deserialize; `publish_answer` / `publish_dismiss_notification` in
 * `ntfy.rs` call `serde_json::to_string` with no golden-byte test near them.
 * That gap belongs in `client/src-tauri/`, not here — do not read this file as
 * covering it.
 */
const CONFIG: HitlConfig = {
  topicId: 'topic-under-test',
  ntfyUrl: 'https://ntfy.sh',
  deviceName: 'test-device',
  soundEnabled: false,
};

/**
 * The exact bytes each message below becomes on the topic.
 *
 * Checked in as raw strings on purpose. Deriving the expectation from the TS
 * types instead — `expect(body).toBe(JSON.stringify(QUESTION))` — proves only
 * that `publish` did not re-encode; add a field to `QuestionMessage` and to the
 * fixture and both sides move together while every installed client breaks.
 * That is exactly how `timeout` left the question message unnoticed. A literal
 * cannot move.
 */
const GOLDEN_QUESTION =
  '{"type":"question","messageId":"21ba33d7-08a8-4761-9abf-5f4e6ba364b1","timestamp":1700000000000,' +
  '"repo":null,"context":"ctx","question":"Proceed?","options":[{"label":"Yes","value":"yes"}],' +
  '"allowMultiple":false,"allowOther":true}';

const GOLDEN_NOTIFICATION =
  '{"type":"notification","messageId":"31ba33d7-08a8-4761-9abf-5f4e6ba364b2","timestamp":1700000000000,' +
  '"title":"Build complete","body":"All green."}';

const GOLDEN_ANSWER =
  '{"type":"answer","messageId":"41ba33d7-08a8-4761-9abf-5f4e6ba364b3","timestamp":1700000000000,' +
  '"questionId":"21ba33d7-08a8-4761-9abf-5f4e6ba364b1","respondedFrom":"Kay9",' +
  '"selectedValues":["yes"],"skipped":false}';

const GOLDEN_DISMISS =
  '{"type":"dismiss_notification","messageId":"51ba33d7-08a8-4761-9abf-5f4e6ba364b4",' +
  '"timestamp":1700000000000,"notificationId":"31ba33d7-08a8-4761-9abf-5f4e6ba364b2",' +
  '"dismissedFrom":"Kay9"}';

/**
 * What v2.9.6 (commit e091198) actually put on the topic for the same question.
 *
 * It is NOT `GOLDEN_QUESTION`. v2.9.6 emitted `timeout: args.timeout || 3600000`
 * between `allowOther` and `questions`; e88ec1b dropped it when ReviewPlan
 * removed tool-level timeouts. That single removal is the whole delta, and the
 * installed client tolerates it because `QuestionMessage.timeout` is
 * `Option<u64>` in `types.rs`, which serde fills with `None` when the key is
 * absent.
 *
 * Kept here so the delta stays a fact the suite enforces rather than a claim in
 * a comment: the test below asserts that re-adding `timeout` to today's bytes
 * reproduces v2.9.6's exactly, so any *second* divergence fails loudly instead
 * of hiding behind this one.
 */
const GOLDEN_QUESTION_V296 =
  '{"type":"question","messageId":"21ba33d7-08a8-4761-9abf-5f4e6ba364b1","timestamp":1700000000000,' +
  '"repo":null,"context":"ctx","question":"Proceed?","options":[{"label":"Yes","value":"yes"}],' +
  '"allowMultiple":false,"allowOther":true,"timeout":3600000}';

/**
 * The same messages as typed literals. These carry the other half of the
 * guarantee: adding a required field to one of these interfaces fails to
 * compile here, and adding an optional one fails the byte comparison above.
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

const ANSWER: AnswerMessage = {
  type: 'answer',
  messageId: '41ba33d7-08a8-4761-9abf-5f4e6ba364b3',
  timestamp: 1_700_000_000_000,
  questionId: '21ba33d7-08a8-4761-9abf-5f4e6ba364b1',
  respondedFrom: 'Kay9',
  selectedValues: ['yes'],
  skipped: false,
};

const DISMISS: DismissNotificationMessage = {
  type: 'dismiss_notification',
  messageId: '51ba33d7-08a8-4761-9abf-5f4e6ba364b4',
  timestamp: 1_700_000_000_000,
  notificationId: '31ba33d7-08a8-4761-9abf-5f4e6ba364b2',
  dismissedFrom: 'Kay9',
};

/** Every member of the frozen union, with the bytes it must produce. */
const SHIPPING: Array<[string, HitlMessage, string]> = [
  ['question', QUESTION, GOLDEN_QUESTION],
  ['notification', NOTIFICATION, GOLDEN_NOTIFICATION],
  ['answer', ANSWER, GOLDEN_ANSWER],
  ['dismiss_notification', DISMISS, GOLDEN_DISMISS],
];

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

  it.each(SHIPPING)('publishes a %s as its frozen bytes', async (_name, message, golden) => {
    await new NtfyTransport(CONFIG).publish(message);

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toBe(golden);
  });

  it('emits no protocolVersion field for any of the four shipping types', async () => {
    const transport = new NtfyTransport(CONFIG);
    for (const [, message] of SHIPPING) {
      await transport.publish(message);
    }

    expect(bodies).toHaveLength(SHIPPING.length);
    for (const body of bodies) {
      expect(body).not.toContain('protocolVersion');
      expect(JSON.parse(body).protocolVersion).toBeUndefined();
    }
  });

  it('differs from v2.9.6 in the dropped timeout field and nothing else', async () => {
    await new NtfyTransport(CONFIG).publish(QUESTION);

    // Re-adding the one field e88ec1b removed must reproduce v2.9.6 byte for
    // byte. A second divergence — a renamed key, a reordered field, a new
    // default — breaks this even though the `timeout` delta is expected.
    const withTimeout = bodies[0].replace(
      '"allowOther":true}',
      '"allowOther":true,"timeout":3600000}'
    );
    expect(withTimeout).toBe(GOLDEN_QUESTION_V296);
  });

  it('wraps the same golden bytes, unaltered, when a key is configured', async () => {
    // The encrypted branch is the one that actually ships: the client refuses
    // to run without a key. Whatever the envelope looks like, what it must
    // contain is the plaintext above and nothing else — a gzip or a re-encode
    // hidden inside encryption breaks the installed client just as completely,
    // and the ciphertext makes it invisible to the plaintext assertions.
    const encryptionKey = randomBytes(32).toString('hex');
    const transport = new NtfyTransport({ ...CONFIG, encryptionKey });

    for (const [, message, golden] of SHIPPING) {
      bodies = [];
      await transport.publish(message);

      expect(bodies).toHaveLength(1);
      expect(decrypt(bodies[0], encryptionKey)).toBe(golden);

      // The envelope shape the Rust client deserializes. serde ignores key
      // order, so the key set is the contract, not the ordering.
      const envelope = JSON.parse(bodies[0]) as Record<string, unknown>;
      expect(isEncryptedEnvelope(envelope)).toBe(true);
      expect(Object.keys(envelope).sort()).toEqual(['_encrypted', 'data', 'iv']);
    }
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

/**
 * The tests above hand `publish` a finished message, so they pin serialization.
 * They cannot see a field dropped where the message is *built* — which is where
 * `timeout` was actually lost (`mcp-server.ts:424`). The annotation on
 * `questionMsg` makes a missing *required* field a compile error, so the live
 * gap is optional fields, and `timeout` was optional.
 *
 * This drives the real AskUserQuestion path and compares against the same
 * `GOLDEN_QUESTION` literal. There is deliberately no second copy of the bytes.
 */
describe('question construction', () => {
  const realFetch = globalThis.fetch;
  const originalHome = process.env.HITL_HOME;
  let home: string;
  let bodies: string[];
  let server: HumanInTheLoopServer;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'hitl-wire-compat-'));
    process.env.HITL_HOME = home;

    bodies = [];
    globalThis.fetch = jest.fn(async (_url: unknown, init: unknown) => {
      bodies.push((init as { body: string }).body);
      return { ok: true, status: 200, statusText: 'OK' } as Response;
    }) as unknown as typeof fetch;

    server = new HumanInTheLoopServer(CONFIG);
    // Not the subject here, and there is no client binary in a temp home.
    (server as unknown as { requireClient: () => void }).requireClient = () => {};
  });

  afterEach(() => {
    (server as unknown as { transport: { close: () => void } }).transport.close();
    globalThis.fetch = realFetch;
    if (originalHome === undefined) delete process.env.HITL_HOME;
    else process.env.HITL_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('builds a question whose bytes are the frozen bytes', async () => {
    // The tool handler is registered on the SDK Server rather than exposed as a
    // method, so this reaches for it directly. An in-memory client pair would
    // be the public route, but it also means a 60 s SDK request timeout with
    // nothing to cancel it.
    const handlers = (
      server as unknown as { server: { _requestHandlers: Map<string, unknown> } }
    ).server._requestHandlers;
    const callTool = handlers.get('tools/call') as (
      req: unknown,
      extra: unknown
    ) => Promise<unknown>;

    // Aborted up front: the publish happens before the wait, so the bytes are
    // captured and then `waitForAnswer` rejects instead of parking forever.
    await expect(
      callTool(
        {
          method: 'tools/call',
          params: {
            name: 'AskUserQuestion',
            arguments: {
              context: 'ctx',
              question: 'Proceed?',
              options: [{ label: 'Yes', value: 'yes' }],
              allowMultiple: false,
              allowOther: true,
            },
          },
        },
        { signal: AbortSignal.abort() }
      )
    ).rejects.toThrow();

    expect(bodies).toHaveLength(1);

    // Three values cannot be frozen — a uuid, a clock reading, and whatever
    // repo the suite happens to run in. Substituting them *into the golden
    // literal* keeps the comparison over the whole byte string, so a dropped,
    // added or reordered field still fails.
    const emitted = bodies[0];
    const live = JSON.parse(emitted) as { messageId: string; timestamp: number; repo: unknown };
    const expected = GOLDEN_QUESTION.replace(
      '"21ba33d7-08a8-4761-9abf-5f4e6ba364b1"',
      JSON.stringify(live.messageId)
    )
      .replace('1700000000000', String(live.timestamp))
      .replace('"repo":null', `"repo":${JSON.stringify(live.repo)}`);

    expect(emitted).toBe(expected);
  });
});
