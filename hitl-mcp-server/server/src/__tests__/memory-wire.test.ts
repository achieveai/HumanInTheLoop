import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { randomBytes } from 'crypto';
import { tmpdir } from 'os';
import path from 'path';
import { NtfyMemoryWire } from '../memory/ntfy-wire.js';
import { MessageLostError, type Payload, type WireEvent } from '../memory/remote.js';
import type { HitlConfig } from '../types.js';

const CONFIG: HitlConfig = {
  topicId: 'hitl-wire-test', ntfyUrl: 'https://ntfy.example', deviceName: 'test', soundEnabled: false,
  encryptionKey: 'ab'.repeat(32),
};
const MARKER = 'the staging database lives in eu-west-1';

const changes = (next: string): Payload => ({
  kind: 'changes', id: 'p1', from: 'd1', cursor: 5, digest: 'x',
  changes: [{ key: 'github.com/example/repo', file: 'fact.md', base: null, next }],
});

/** A fake ntfy: records what is sent, serves attachments, streams the lines it is given. */
function fakeNtfy() {
  const sent: Array<{ method: string; body: string; message?: string }> = [];
  const files = new Map<string, string>();
  let lines: string[] = [];
  globalThis.fetch = jest.fn(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    if (method === 'POST' || method === 'PUT') {
      const message = (init?.headers as Record<string, string> | undefined)?.['X-Message'];
      sent.push({ method, body: String(init?.body), message });
      if (method === 'PUT') files.set('https://ntfy.example/file/a.bin', String(init?.body));
      return new Response('{}', { status: 200 });
    }
    if (u.includes('/json?since=')) {
      // Split each line across two chunks, as a network may.
      const chunks = lines.flatMap(line => [line.slice(0, 7), `${line.slice(7)}\n`]);
      return new Response(new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
          controller.close();
        },
      }), { status: 200 });
    }
    const file = files.get(u);
    return file === undefined ? new Response('', { status: 404 }) : new Response(file, { status: 200 });
  }) as unknown as typeof fetch;
  return { sent, files, setLines: (next: string[]) => { lines = next; } };
}

async function streamAll(wire: NtfyMemoryWire): Promise<WireEvent[]> {
  const events: WireEvent[] = [];
  await wire.stream(1, event => events.push(event), new AbortController().signal);
  return events;
}

describe('NtfyMemoryWire', () => {
  const realFetch = globalThis.fetch;
  const originalHome = process.env.HITL_HOME;

  beforeEach(() => {
    process.env.HITL_HOME = path.join(tmpdir(), 'hitl-wire-test');
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (originalHome === undefined) delete process.env.HITL_HOME;
    else process.env.HITL_HOME = originalHome;
  });

  it('sends a payload encrypted and reads it back, skipping the open event', async () => {
    const ntfy = fakeNtfy();
    const wire = new NtfyMemoryWire(CONFIG, () => {});
    const payload = changes(`${MARKER}\n`);
    await wire.publish(payload);
    expect(ntfy.sent).toHaveLength(1);
    expect(ntfy.sent[0].body).not.toContain('eu-west-1');

    ntfy.setLines([
      JSON.stringify({ id: 'o1', time: 200, event: 'open', topic: 'hitl-wire-test-memory' }),
      JSON.stringify({ id: 'm1', time: 100, event: 'message', message: ntfy.sent[0].body }),
      JSON.stringify({ id: 'k1', time: 201, event: 'keepalive' }),
    ]);
    const events = await streamAll(wire);
    expect(events.map(e => [e.id, e.time])).toEqual([['m1', 100], ['k1', 201]]);
    expect(await events[0].load!()).toEqual(payload);
  });

  it('sends a large payload as an encrypted attachment, and calls an expired one lost', async () => {
    const ntfy = fakeNtfy();
    const wire = new NtfyMemoryWire(CONFIG, () => {});
    const payload = changes(`${MARKER}\n${randomBytes(6_000).toString('hex')}\n`);
    await wire.publish(payload);
    expect(ntfy.sent).toHaveLength(1);
    expect(ntfy.sent[0].method).toBe('PUT');
    expect(ntfy.sent[0].body).not.toContain('eu-west-1');

    const attachment = { name: 'a.bin', url: 'https://ntfy.example/file/a.bin' };
    ntfy.setLines([JSON.stringify({ id: 'm2', time: 100, event: 'message', message: ntfy.sent[0].message, attachment })]);
    const [event] = await streamAll(wire);
    expect(await event.load!()).toEqual(payload);

    ntfy.files.clear();
    await expect(event.load!()).rejects.toBeInstanceOf(MessageLostError);
  });

  it('ignores a message under another key, and says once that the keys differ', async () => {
    const ntfy = fakeNtfy();
    await new NtfyMemoryWire({ ...CONFIG, encryptionKey: 'cd'.repeat(32) }, () => {}).publish(changes('x\n'));
    const logs: string[] = [];
    const wire = new NtfyMemoryWire(CONFIG, message => logs.push(message));
    const line = (id: string) => JSON.stringify({ id, time: 100, event: 'message', message: ntfy.sent[0].body });
    ntfy.setLines([line('m1'), line('m2'), JSON.stringify({ id: 'm3', time: 101, event: 'message', message: 'hello' })]);
    const events = await streamAll(wire);
    for (const event of events) expect(await event.load!()).toBeNull();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('encryptionKey');
  });
});
