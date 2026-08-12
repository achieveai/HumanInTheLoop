import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { NtfyTransport } from '../ntfy-transport.js';
import type { QuestionMessage, NotificationMessage, HitlConfig } from '../types.js';

/**
 * Non-negotiable #1: the four shipping message types keep a BYTE-IDENTICAL wire
 * format. A new server publishing a changed shape to an already-installed
 * client decrypts fine, fails every parse, and falls through the client's
 * dispatch — no window, no log. With timeouts removed the agent then hangs
 * forever, and it would hit ordinary AskUserQuestion calls, not just plans.
 *
 * So: no protocolVersion in their emitted JSON, no gzip, no re-encoding.
 */
const CONFIG: HitlConfig = {
  topicId: 'topic-under-test',
  ntfyUrl: 'https://ntfy.sh',
  deviceName: 'test-device',
  soundEnabled: false,
};

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

  it('publishes a question as the plain JSON of the message, unchanged', async () => {
    await new NtfyTransport(CONFIG).publish(QUESTION);

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toBe(JSON.stringify(QUESTION));
  });

  it('publishes a notification as the plain JSON of the message, unchanged', async () => {
    await new NtfyTransport(CONFIG).publish(NOTIFICATION);

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toBe(JSON.stringify(NOTIFICATION));
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
