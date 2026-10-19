import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  MessageLostError, RemoteSync, applyChange, type Payload, type RemoteSyncOptions, type Wire, type WireEvent,
} from '../memory/remote.js';
import { sharedDir, syncDir } from '../memory/sync.js';
import { findSecret } from '../memory/secrets.js';

const KEY = 'github.com/example/memtest';

/**
 * ntfy in memory: one ordered log, replay from `since`, then live. The clock
 * only moves on `advance`. Like ntfy, the replay arrives over time, one message
 * per chunk, so a machine may drain part way through it.
 */
class FakeTopic {
  clock = 1_000;
  events: Array<{ id: string; time: number; payload: Payload; expired?: boolean }> = [];
  published: Payload[] = [];
  /** Streams still replaying; a settle waits for them, as a real catch-up finishes long before a keepalive. */
  replaying = 0;
  private subscribers = new Map<(event: WireEvent) => void, string>();
  /** Messages each subscriber will miss, as if its connection dropped them. */
  private drops = new Map<string, number>();
  private nextId = 0;

  wire(name: string): Wire {
    return {
      publish: async payload => {
        this.published.push(payload);
        this.push({ id: `m${String(this.nextId++).padStart(4, '0')}`, time: this.clock, payload });
      },
      stream: async (since, onEvent, signal) => {
        this.replaying++;
        try {
          // Reads the length each round, so a message published during the replay is not missed.
          for (let i = 0; i < this.events.length; i++) {
            await new Promise(resolve => setImmediate(resolve));
            if (signal.aborted) return;
            if (this.events[i].time >= since) onEvent(this.toWire(this.events[i]));
          }
        } finally {
          this.replaying--;
        }
        if (signal.aborted) return;
        this.subscribers.set(onEvent, name);
        await new Promise<void>(resolve => signal.addEventListener('abort', () => {
          this.subscribers.delete(onEvent);
          resolve();
        }));
      },
    };
  }

  push(event: { id: string; time: number; payload: Payload; expired?: boolean }): void {
    this.events.push(event);
    for (const [send, name] of this.subscribers) {
      const drops = this.drops.get(name) ?? 0;
      if (drops > 0) this.drops.set(name, drops - 1);
      else send(this.toWire(event));
    }
  }

  drop(name: string, count: number): void {
    this.drops.set(name, count);
  }

  /** Move to the next second and send a keepalive, which finishes the one before. */
  advance(): void {
    this.clock++;
    for (const send of this.subscribers.keys()) send({ id: 'keepalive', time: this.clock });
  }

  private toWire(event: { id: string; time: number; payload: Payload; expired?: boolean }): WireEvent {
    return {
      id: event.id,
      time: event.time,
      load: async () => {
        if (event.expired) throw new MessageLostError('attachment expired');
        return JSON.parse(JSON.stringify(event.payload)) as Payload;
      },
    };
  }
}

let dir: string;
let machines: RemoteSync[];
let notices: string[];

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'hitl-remote-'));
  machines = [];
  notices = [];
});

afterEach(() => {
  for (const machine of machines) machine.stop();
  rmSync(dir, { recursive: true, force: true });
});

function machine(
  name: string, topic: FakeTopic, device?: string, options: Partial<RemoteSyncOptions> = {},
): RemoteSync & { root: string } {
  const root = path.join(dir, name);
  if (device) {
    mkdirSync(path.join(root, '.sync'), { recursive: true });
    writeFileSync(path.join(root, '.sync', 'remote.json'), JSON.stringify({ device }));
  }
  const sync = new RemoteSync({
    wire: topic.wire(name),
    root,
    localKeys: () => [KEY],
    notify: tag => notices.push(tag),
    log: () => {},
    snapshotWaitMs: 200,
    settleDelayMs: 10,
    answerDelayMs: () => 0,
    now: () => topic.clock * 1000,
    ...options,
  });
  machines.push(sync);
  return Object.assign(sync, { root });
}

const shared = (m: { root: string }, file: string) => path.join(sharedDir(KEY, m.root), file);
const shadow = (m: { root: string }, file: string) => path.join(syncDir(KEY, m.root), 'remote', file);
const write = (m: { root: string }, file: string, text: string) => {
  mkdirSync(sharedDir(KEY, m.root), { recursive: true });
  writeFileSync(shared(m, file), text);
};
const read = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8') : null);
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Wait until `check` holds, as a busy machine may take a while; fail after `ms`. */
async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await wait(5);
  }
}

/** Let every machine handle what has arrived, finishing the current second. */
async function settle(topic: FakeTopic): Promise<void> {
  for (let round = 0; round < 3; round++) {
    await until(() => topic.replaying === 0);
    topic.advance();
    await wait(5);
    await Promise.all(machines.map(m => m.idle()));
  }
}

/** A first machine that found no peer, and a second that took its snapshot. */
async function twoMachines(topic: FakeTopic) {
  const a = machine('a', topic, 'a');
  a.start();
  await until(() => a.ready);
  const b = machine('b', topic, 'b');
  b.start();
  await until(() => b.ready);
  await settle(topic);
  return [a, b] as const;
}

async function tickAll(topic: FakeTopic): Promise<void> {
  for (const m of machines) await m.tick();
  await settle(topic);
}

describe('applyChange', () => {
  it('lets an edit beat a delete from either side, and merges two edits', () => {
    expect(applyChange('x\n', null, 'x edited\n').text).toBe('x edited\n');
    expect(applyChange('x\n', 'x edited\n', null).text).toBe('x edited\n');
    expect(applyChange('x\n', 'x\n', null).text).toBeNull();
    expect(applyChange('a\nb\n', 'a\nB1\n', 'a\nB2\n')).toEqual({ text: 'a\nB1\nB2\n', clashed: true });
  });
});

describe('RemoteSync', () => {
  it('carries a new memory to the other machine', async () => {
    const topic = new FakeTopic();
    const [a, b] = await twoMachines(topic);
    write(a, 'fact.md', 'deploys run on Fridays\n');
    await tickAll(topic);
    expect(read(shared(b, 'fact.md'))).toBe('deploys run on Fridays\n');
  });

  it('ends byte-identical everywhere when two machines edit the same line, keeping both', async () => {
    const topic = new FakeTopic();
    const [a, b] = await twoMachines(topic);
    write(a, 'fact.md', 'one\ntwo\n');
    await tickAll(topic);

    write(a, 'fact.md', 'one\ntwo from a\n');
    write(b, 'fact.md', 'one\ntwo from b\n');
    await tickAll(topic);
    await tickAll(topic);

    const all = [shared(a, 'fact.md'), shared(b, 'fact.md'), shadow(a, 'fact.md'), shadow(b, 'fact.md')].map(read);
    expect(new Set(all).size).toBe(1);
    expect(all[0]).toContain('two from a');
    expect(all[0]).toContain('two from b');
    expect(notices.filter(n => n.startsWith('clash:'))).toHaveLength(1);
  });

  it('lets an edit on one machine beat a delete on the other', async () => {
    const topic = new FakeTopic();
    const [a, b] = await twoMachines(topic);
    write(a, 'fact.md', 'one\n');
    await tickAll(topic);
    rmSync(shared(a, 'fact.md'));
    write(b, 'fact.md', 'one, edited\n');
    await tickAll(topic);
    await tickAll(topic);
    expect([read(shared(a, 'fact.md')), read(shared(b, 'fact.md'))]).toEqual(['one, edited\n', 'one, edited\n']);
  });

  it('does not send a file again while its change is still in flight', async () => {
    const topic = new FakeTopic();
    const [a] = await twoMachines(topic);
    const before = topic.published.length;
    write(a, 'fact.md', 'x\n');
    await a.tick();
    await a.tick();
    expect(topic.published.length - before).toBe(1);
    await settle(topic);
    await a.tick();
    expect(topic.published.length - before).toBe(1);
  });

  it('applies same-second changes in one order however they arrive', async () => {
    const changes = (id: string, from: string, next: string): { id: string; time: number; payload: Payload } => ({
      id, time: 5_000, payload: { kind: 'changes', id, from, cursor: 0, digest: 'x', changes: [{ key: KEY, file: 'f.md', base: null, next }] },
    });
    const first = changes('m-a', 'p', 'from p\n');
    const second = changes('m-b', 'q', 'from q\n');
    const results: Array<string | null> = [];
    for (const order of [[first, second], [second, first]]) {
      const topic = new FakeTopic();
      const m = machine(`m${results.length}`, topic);
      m.start();
      await until(() => m.ready);
      topic.clock = 5_000;
      for (const event of order) topic.push(event);
      await settle(topic);
      results.push(read(shared(m, 'f.md')));
    }
    expect(results[0]).toBe('from p\nfrom q\n');
    expect(results[1]).toBe(results[0]);
  });

  it('heals a machine whose shadows drifted, through a snapshot', async () => {
    const topic = new FakeTopic();
    const [a, b] = await twoMachines(topic);
    write(a, 'fact.md', 'agreed\n');
    await tickAll(topic);
    topic.drop('b', 1);
    write(a, 'fact.md', 'agreed, then edited\n');
    await tickAll(topic);
    expect(read(shared(b, 'fact.md'))).toBe('agreed\n'); // b missed it, and nobody will send it again

    write(a, 'other.md', 'new\n');
    await tickAll(topic);
    await until(() => read(shadow(b, 'fact.md')) === 'agreed, then edited\n');
    await settle(topic);

    expect(read(shadow(b, 'fact.md'))).toBe('agreed, then edited\n');
    expect(read(shared(b, 'fact.md'))).toBe('agreed, then edited\n');
    expect(read(shared(b, 'other.md'))).toBe('new\n');
  });

  it('merges a new machine’s own memories in when it joins', async () => {
    const topic = new FakeTopic();
    const a = machine('a', topic, 'a');
    a.start();
    await until(() => a.ready);
    write(a, 'theirs.md', 'from a\n');
    await tickAll(topic);

    const b = machine('b', topic, 'b');
    write(b, 'mine.md', 'from b\n');
    b.start();
    await until(() => b.ready);
    await settle(topic);
    await tickAll(topic);

    for (const m of [a, b]) {
      expect(read(shared(m, 'theirs.md'))).toBe('from a\n');
      expect(read(shared(m, 'mine.md'))).toBe('from b\n');
    }
  });

  it('keeps a file that looks like it holds a secret on this machine, and says so once', async () => {
    const topic = new FakeTopic();
    const [a, b] = await twoMachines(topic);
    write(a, 'creds.md', `token: ghp_${'x'.repeat(36)}\n`);
    await tickAll(topic);
    await tickAll(topic);
    expect(read(shared(b, 'creds.md'))).toBeNull();
    expect(notices.filter(n => n.startsWith('secret:'))).toHaveLength(2); // the caller rate-limits per tag
  });

  it('asks for a snapshot when a change can no longer be fetched', async () => {
    const topic = new FakeTopic();
    const [, b] = await twoMachines(topic);
    topic.push({
      id: 'gone', time: topic.clock, expired: true,
      payload: { kind: 'changes', id: 'gone', from: 'z', cursor: 0, digest: 'x', changes: [] },
    });
    const before = topic.published.length;
    await settle(topic);
    expect(topic.published.slice(before).some(p => p.kind === 'snapshot_request' && p.from === b.device)).toBe(true);
  });

  it('sees no drift when a second is finished by the clock rather than by a later event', async () => {
    const topic = new FakeTopic();
    const [a, b] = await twoMachines(topic);
    const before = topic.published.length;
    write(a, 'fact.md', 'one\n');
    await a.tick();
    topic.clock += 10; // a quiet topic: no keepalive, so only the settle timer finishes the second
    await wait(40);
    await Promise.all(machines.map(m => m.idle()));
    write(a, 'other.md', 'two\n');
    await tickAll(topic);
    expect(topic.published.slice(before).filter(p => p.kind !== 'changes')).toEqual([]);
    expect(read(shared(b, 'other.md'))).toBe('two\n');
  });

  it('ignores repo keys and file names that would leave the memory folder', async () => {
    const topic = new FakeTopic();
    const [a] = await twoMachines(topic);
    topic.push({
      id: 'evil', time: topic.clock,
      payload: {
        kind: 'changes', id: 'evil', from: 'z', cursor: 0, digest: 'x',
        changes: [
          { key: 'github.com/../../escape', file: 'x.md', base: null, next: 'x' },
          { key: KEY, file: '../escape.md', base: null, next: 'x' },
        ],
      },
    });
    await settle(topic);
    expect(existsSync(path.join(a.root, 'escape'))).toBe(false);
    expect(existsSync(path.join(sharedDir(KEY, a.root), '..', 'escape.md'))).toBe(false);
  });

  it('picks up what it missed while stopped, from its saved cursor', async () => {
    const topic = new FakeTopic();
    const [a, b] = await twoMachines(topic);
    b.stop();
    write(a, 'fact.md', 'while b was away\n');
    await tickAll(topic);
    topic.clock += 600;
    const before = topic.published.length;

    const again = machine('b', topic); // same folder and saved state: a new session on that machine
    again.start();
    await settle(topic);
    expect(read(shared(again, 'fact.md'))).toBe('while b was away\n');
    expect(topic.published.slice(before).some(p => p.kind === 'snapshot_request')).toBe(false);
  });

  it('applies each change once, even when a restart replays it', async () => {
    const topic = new FakeTopic();
    const [a, b] = await twoMachines(topic);
    const state = path.join(b.root, '.sync', 'remote.json');
    const early = JSON.parse(readFileSync(state, 'utf8')).cursor as number;
    write(a, 'fact.md', 'one\n');
    await tickAll(topic);
    write(a, 'fact.md', 'one\ntwo\n');
    await tickAll(topic);
    b.stop();
    // Killed after applying both changes but before its cursor reached the disk.
    writeFileSync(state, JSON.stringify({ ...JSON.parse(readFileSync(state, 'utf8')), cursor: early }));

    const again = machine('b', topic);
    again.start();
    await settle(topic);
    expect(read(shadow(again, 'fact.md'))).toBe('one\ntwo\n');
    expect(read(shared(again, 'fact.md'))).toBe('one\ntwo\n');
  });

  it('moves past a change it can never fetch when no peer answers', async () => {
    const topic = new FakeTopic();
    const [a, b] = await twoMachines(topic);
    a.stop(); // nobody left to answer
    const before = topic.published.length;
    const at = topic.clock;
    topic.push({
      id: 'gone', time: at, expired: true,
      payload: { kind: 'changes', id: 'gone', from: 'z', cursor: at - 1, digest: 'x', changes: [] },
    });
    topic.push({
      id: 'later', time: at,
      payload: {
        kind: 'changes', id: 'later', from: 'z', cursor: at - 1, digest: 'x',
        changes: [{ key: KEY, file: 'later.md', base: null, next: 'later\n' }],
      },
    });
    await settle(topic);
    await until(() => read(shared(b, 'later.md')) === 'later\n');
    await wait(500); // time for two more snapshot waits, were it still stuck
    await settle(topic);
    expect(topic.published.slice(before).filter(p => p.kind === 'snapshot_request')).toHaveLength(1);
  });

  it('still applies the rest of a second when updating replicas fails once', async () => {
    const topic = new FakeTopic();
    let fail = true;
    const m = machine('m', topic, undefined, {
      onChanged: () => {
        if (!fail) return;
        fail = false;
        throw new Error('replica busy');
      },
    });
    m.start();
    await until(() => m.ready);
    const at = topic.clock;
    for (const file of ['one.md', 'two.md']) {
      topic.push({
        id: `m-${file}`, time: at,
        payload: {
          kind: 'changes', id: `p-${file}`, from: 'z', cursor: at - 1, digest: 'x',
          changes: [{ key: KEY, file, base: null, next: `${file}\n` }],
        },
      });
    }
    await settle(topic);
    expect(read(shared(m, 'one.md'))).toBe('one.md\n');
    expect(read(shared(m, 'two.md'))).toBe('two.md\n');
  });

  it('ignores a change that arrives twice, or is posted again much later', async () => {
    const topic = new FakeTopic();
    const [a, b] = await twoMachines(topic);
    write(a, 'fact.md', 'x\n');
    await tickAll(topic);
    const sent = topic.published.filter(p => p.kind === 'changes').at(-1)!;
    rmSync(shared(b, 'fact.md'));
    await tickAll(topic);
    expect(read(shared(a, 'fact.md'))).toBeNull();

    topic.push({ id: 'copy', time: topic.clock, payload: sent }); // a publish retried after ntfy stored it
    await settle(topic);
    topic.clock += 14 * 3600;
    await settle(topic);
    topic.push({ id: 'again', time: topic.clock, payload: sent }); // the old sealed message, posted again
    await settle(topic);
    for (const m of [a, b]) expect(read(shared(m, 'fact.md'))).toBeNull();
  });

  it('keeps memory that a snapshot lacks, after a long time away', async () => {
    const topic = new FakeTopic();
    const a = machine('a', topic, 'z'); // the larger id, so it is the one that asks
    a.start();
    await until(() => a.ready);
    await settle(topic);
    write(a, 'old.md', 'from long ago\n');
    await tickAll(topic);
    expect(read(shadow(a, 'old.md'))).toBe('from long ago\n');
    a.stop();

    topic.events = []; // ntfy has dropped it since
    topic.clock += 12 * 3600;
    const b = machine('b', topic, 'b');
    b.start();
    await until(() => b.ready); // nobody answers, so b starts from the empty topic
    await settle(topic);
    write(b, 'new.md', 'recent\n');
    await tickAll(topic);

    // Offline over 11 h, so it asks; b answers without old.md. b only sees the request once its
    // second is finished, so move the clock; and wait longer than the test, so back can only
    // become ready by taking that answer, never by giving up on it.
    const back = machine('a', topic, undefined, { snapshotWaitMs: 60_000 });
    back.start();
    await settle(topic);
    await until(() => back.ready);
    await tickAll(topic);
    await tickAll(topic);
    expect(topic.published.some(p => p.kind === 'snapshot_request' && p.from === back.device)).toBe(true);
    for (const m of [back, b]) {
      expect(read(shared(m, 'old.md'))).toBe('from long ago\n');
      expect(read(shared(m, 'new.md'))).toBe('recent\n');
    }
  });
});

describe('findSecret', () => {
  it('spots common credential shapes and leaves prose alone', () => {
    expect(findSecret('-----BEGIN OPENSSH PRIVATE KEY-----')).toBe('private key');
    expect(findSecret('key AKIAABCDEFGHIJKLMNOP here')).toBe('AWS access key');
    expect(findSecret('password = hunter2hunter2hunter2')).toBe('assigned secret');
    expect(findSecret('Run `npm test` before pushing; the token cache lives in ~/.hitl.')).toBeNull();
  });
});
