import { createHash, randomBytes } from 'crypto';
import path from 'path';
import { mergeMemoryFile } from './merge3.js';
import { findSecret } from './secrets.js';
import {
  atomicWrite, memoryFiles, memoryRoot, put, read, readRegistry, sharedDir, syncDir, tooBig,
} from './sync.js';

/** One file's change as its sender saw it: the agreed text it started from, and its new text. */
export interface Change {
  key: string;
  file: string;
  base: string | null;
  next: string | null;
}

/** What travels on the memory topic. `cursor` and `digest` let a receiver spot that it has drifted. */
export type Payload =
  | { kind: 'changes'; id: string; from: string; cursor: number; digest: string; changes: Change[] }
  | { kind: 'snapshot_request'; id: string; from: string }
  | {
      kind: 'snapshot'; id: string; from: string; requestId: string; cursor: number; digest: string;
      shadows: Record<string, Record<string, string>>;
      /** The answerer's handled ids, so the asker skips what these shadows already include. */
      seen: Record<string, number>;
    };

export type ChangesPayload = Extract<Payload, { kind: 'changes' }>;

/** One event off the topic. Only messages have `load`; open and keepalive events just mark the time. */
export interface WireEvent {
  id: string;
  /** ntfy's server time, unix seconds. */
  time: number;
  /**
   * The payload, or null for a message that is not ours. Throws MessageLostError
   * when the message can never be read (its attachment expired); any other
   * throw is taken as passing, and the message is tried again.
   */
  load?: () => Promise<Payload | null>;
}

/** A message that can never be read, so waiting for it is pointless. */
export class MessageLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MessageLostError';
  }
}

export interface Wire {
  publish(payload: Payload): Promise<void>;
  /**
   * Stream events from `since` (unix seconds, inclusive) until the connection
   * ends or `signal` aborts. Report messages and keepalives only: ntfy stamps
   * its open event with the current time and then replays older messages,
   * and a time that runs backwards would finish seconds not yet seen.
   */
  stream(since: number, onEvent: (event: WireEvent) => void, signal: AbortSignal): Promise<void>;
}

/**
 * Apply one change (`base` → `next`) to `current`, the text it lands on.
 * The same rules as a local sync: an untouched side takes the change, an edit
 * beats a delete, and two edits merge, keeping both where they overlap.
 */
export function applyChange(
  base: string | null, current: string | null, next: string | null,
): { text: string | null; clashed: boolean } {
  if (current === base || current === next) return { text: next, clashed: false };
  if (next === base) return { text: current, clashed: false };
  if (current === null || next === null) return { text: current ?? next, clashed: false };
  return mergeMemoryFile(base ?? '', current, next);
}

/** How long a sent change may stay unechoed before its file is sent again. */
const IN_FLIGHT_MS = 120_000;
/** A second counts as finished this long after it, even with no later event to prove it. */
const SETTLE_SECONDS = 3;
/** Offline longer than this and the topic may have dropped changes (ntfy keeps 12 h by default). */
const GAP_SECONDS = 11 * 3600;
/**
 * Digest and handled-id history. Longer than ntfy keeps messages, so every
 * replayable message is either remembered or too old to apply.
 */
const DIGEST_HISTORY_SECONDS = 13 * 3600;
/** After a drift snapshot that nobody answered, wait this long before asking again. */
const DRIFT_COOLDOWN_MS = 10 * 60_000;
/** Cap on one outgoing message, so a first import does not become one giant upload. */
const MAX_BATCH_CHARS = 2_000_000;

interface RemoteState {
  device: string;
  /** Last second fully applied; null until this machine has a starting point. */
  cursor: number | null;
  /** Server time of the last event seen, for gap detection. */
  lastSeen: number;
  /** Repos that have shared state on the topic. */
  keys: string[];
  /** [second, digest of every shadow after applying it], ascending. */
  digests: Array<[number, string]>;
  /** Sent changes not yet seen coming back, by `key\nfile`. `expected` is what we last put in the shared folder. */
  pending: Record<string, { id: string; at: number; expected: string | null }>;
  /**
   * Changes payloads already applied, and messages given up on, by id, with
   * their server second. A replay or a second copy of one is skipped, because
   * applying a change twice is not a no-op.
   */
  seen: Record<string, number>;
}

export interface RemoteSyncOptions {
  wire: Wire;
  /** Memory root (`~/.hitl/memory`); two in one process stand in for two machines in tests. */
  root?: string;
  /** Repos this machine syncs locally, beyond those already on the topic. */
  localKeys?: () => string[];
  /** Carry changed shared folders into their replicas. */
  onChanged?: (keys: string[]) => void;
  /** Tell the human, once per `tag` (the caller rate-limits). */
  notify?: (tag: string, title: string, body: string) => void;
  log?: (message: string) => void;
  snapshotWaitMs?: number;
  /** How long after the last event to look again for seconds the clock has finished. */
  settleDelayMs?: number;
  answerDelayMs?: () => number;
  now?: () => number;
}

/**
 * Keeps this machine's shared memory folders in step with every other machine
 * through one ntfy topic, which gives all of them the same order of changes.
 *
 * Each file has a remote shadow: the text agreed through the topic. A shared
 * file that differs from its shadow goes out as a change. Every machine,
 * the sender included, applies every change in topic order, sorted by
 * (server second, message id) one finished second at a time, so live and
 * replayed messages line up identically and the shadows stay byte-identical.
 */
export class RemoteSync {
  private readonly root: string;
  private readonly wire: Wire;
  private state: RemoteState;
  private buffer: WireEvent[] = [];
  /** Latest server time seen on the current connection, and the local clock when it was seen. */
  private latest = 0;
  private latestAt = 0;
  private queue: Promise<void> = Promise.resolve();
  private streamAbort: AbortController | null = null;
  private awaiting: { id: string; timer: NodeJS.Timeout } | null = null;
  private driftUntil = 0;
  private answered = new Set<string>();
  private settleTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private publishing = false;
  /** Changes applied past the cursor, because a drain stopped part way. Sending waits, so cursor and digest agree. */
  private behind = false;
  private saved = '';

  constructor(private readonly options: RemoteSyncOptions) {
    this.root = options.root ?? memoryRoot();
    this.wire = options.wire;
    this.state = this.load();
  }

  get device(): string {
    return this.state.device;
  }

  /** Whether this machine has a starting point and is not waiting on a snapshot. */
  get ready(): boolean {
    return this.state.cursor !== null && !this.awaiting;
  }

  start(): void {
    void this.run();
    const offline = this.state.lastSeen > 0 && this.nowSec() - this.state.lastSeen > GAP_SECONDS;
    if (this.state.cursor === null || offline) void this.requestSnapshot();
  }

  stop(): void {
    this.stopped = true;
    this.streamAbort?.abort();
    if (this.awaiting) clearTimeout(this.awaiting.timer);
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.save();
  }

  /** Wait until every event received so far has been handled. For tests and the final pass. */
  async idle(): Promise<void> {
    let seen: Promise<void> | undefined;
    while (seen !== this.queue) {
      seen = this.queue;
      await seen;
    }
  }

  /**
   * Send every shared file that differs from its shadow, as one message.
   * The message is built inside the receive queue, so its cursor and digest
   * describe the state between two applied seconds, never half of one.
   */
  async tick(): Promise<void> {
    if (this.publishing) return;
    let payload: ChangesPayload | null = null;
    this.queue = this.queue.then(() => {
      payload = this.prepare();
    }).catch(err => this.log(`memory: preparing changes failed: ${(err as Error).message}`));
    await this.queue;
    this.save();
    const sent = payload as ChangesPayload | null;
    if (!sent) return;
    this.publishing = true;
    try {
      await this.wire.publish(sent);
    } catch (err) {
      for (const change of sent.changes) delete this.state.pending[`${change.key}\n${change.file}`];
      this.log(`memory: sending ${sent.changes.length} change(s) failed: ${(err as Error).message}`);
    } finally {
      this.publishing = false;
    }
  }

  private prepare(): ChangesPayload | null {
    // Cursor 0 means no event seen yet; a change made against it would look too old to apply.
    if (!this.ready || this.behind || this.state.cursor === 0) return null;
    const keys = [...new Set([...this.state.keys, ...(this.options.localKeys?.() ?? defaultLocalKeys())])].sort();
    const changes: Change[] = [];
    let size = 0;
    for (const key of keys) {
      for (const file of this.files(key)) {
        const { shared, shadow } = this.paths(key, file);
        if (tooBig(shared) || tooBig(shadow)) continue;
        const next = read(shared);
        const base = read(shadow);
        if (next === base) continue;
        const inFlight = this.state.pending[`${key}\n${file}`];
        if (inFlight && this.now() - inFlight.at < IN_FLIGHT_MS) continue;
        const secret = next === null ? null : findSecret(next);
        if (secret) {
          this.options.notify?.(`secret:${key}/${file}:${hash(next!)}`, 'Memory kept on this machine',
            `\`${file}\` in ${key} looks like it holds a ${secret}, so it was not synced to your other machines. Remove the secret to sync it.`);
          continue;
        }
        changes.push({ key, file, base, next });
        size += (base?.length ?? 0) + (next?.length ?? 0);
        if (size > MAX_BATCH_CHARS) break;
      }
      if (size > MAX_BATCH_CHARS) break;
    }
    if (changes.length === 0) return null;

    const payload: ChangesPayload = {
      kind: 'changes', id: newId(), from: this.device, cursor: this.state.cursor!, digest: this.digest(), changes,
    };
    for (const change of changes) {
      this.state.pending[`${change.key}\n${change.file}`] = { id: payload.id, at: this.now(), expected: change.next };
    }
    return payload;
  }

  // ---------------------------------------------------------------- receiving

  private async run(): Promise<void> {
    let backoff = 1_000;
    while (!this.stopped) {
      const controller = new AbortController();
      this.streamAbort = controller;
      this.buffer = [];
      // Waiting on a snapshot, look back a little in case our clock runs ahead of ntfy's.
      const since = this.awaiting || this.state.cursor === null ? this.serverNow() - 30 : this.state.cursor + 1;
      // Only this connection's events may finish a second: what an earlier one saw says nothing
      // about the replay still to come, and finishing seconds early would skip it.
      this.latest = 0;
      const connectedAt = this.now();
      try {
        await this.wire.stream(since, event => this.onEvent(event), controller.signal);
      } catch (err) {
        if (!controller.signal.aborted) this.log(`memory: topic stream failed: ${(err as Error).message}`);
      }
      if (this.stopped) return;
      if (controller.signal.aborted) continue; // restarted on purpose, from a new cursor
      if (this.now() - connectedAt > 5_000) backoff = 1_000;
      await new Promise(resolve => setTimeout(resolve, backoff).unref());
      backoff = Math.min(backoff * 2, 30_000);
    }
  }

  /** Drop the current stream and reconnect from the current cursor. */
  private restart(): void {
    this.buffer = [];
    this.streamAbort?.abort();
  }

  private onEvent(event: WireEvent): void {
    if (event.time > this.latest) {
      this.latest = event.time;
      this.latestAt = this.now();
    }
    this.state.lastSeen = Math.max(this.state.lastSeen, event.time);
    if (event.load) this.buffer.push(event);
    this.schedule();
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => this.schedule(), this.options.settleDelayMs ?? (SETTLE_SECONDS + 0.5) * 1000);
    this.settleTimer.unref();
  }

  private schedule(): void {
    this.queue = this.queue.then(() => this.drain()).catch(err => this.log(`memory: ${(err as Error).message}`));
  }

  /** Server time now, estimated from the last event. */
  private serverNow(): number {
    return this.latest ? this.latest + Math.floor((this.now() - this.latestAt) / 1000) : this.nowSec();
  }

  /**
   * Handle every buffered event whose second has finished: a later event
   * arrived, or the second is a few seconds old. Waiting for a snapshot,
   * order does not matter and everything is handled at once.
   *
   * An event leaves the buffer only once handled. When one fails, it and the
   * rest wait for the next drain and the cursor holds, so nothing is skipped;
   * the seen ids keep the retry from applying anything twice.
   */
  private async drain(): Promise<void> {
    const waiting = !this.ready;
    // Read once: events that arrive while this drain awaits a load must not finish seconds it never handled.
    const latest = this.latest;
    const settled = latest ? this.serverNow() - SETTLE_SECONDS : -Infinity;
    const done = (e: WireEvent) => waiting || e.time < latest || e.time <= settled;
    const ready = this.buffer.filter(done).sort((a, b) => a.time - b.time || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (ready.length === 0 && waiting) return;

    for (const event of ready) {
      // A reconnect dropped the buffer; these events come again from the cursor.
      if (!this.buffer.includes(event)) return;
      const outcome = await this.handleEvent(event);
      if (outcome === 'retry') return;
      this.buffer = this.buffer.filter(e => e !== event);
      if (outcome === 'stop') return;
    }

    if (this.ready && latest) {
      // Every second that `done` accepted is finished, so the cursor covers all applied changes.
      const finished = Math.max(latest - 1, settled);
      if (finished > this.state.cursor!) this.state.cursor = finished;
      this.behind = false;
      this.forget();
      this.save();
    }
  }

  /** `retry`: leave it for the next drain. `stop`: the rest of the batch is stale. */
  private async handleEvent(event: WireEvent): Promise<'done' | 'retry' | 'stop'> {
    if (this.ready && event.time <= this.state.cursor!) return 'done'; // already applied
    if (this.state.seen[event.id] !== undefined) return 'done'; // given up on before
    let payload: Payload | null;
    try {
      payload = await event.load!();
    } catch (err) {
      if (!(err instanceof MessageLostError)) {
        this.log(`memory: could not read a message yet (${(err as Error).message}); will try again`);
        return 'retry';
      }
      this.log(`memory: lost a change (${err.message}); asking a peer for a snapshot`);
      this.state.seen[event.id] = event.time;
      await this.requestSnapshot();
      return 'stop';
    }
    if (!payload) return 'done';
    try {
      return (await this.handle(payload, event.time)) ? 'stop' : 'done';
    } catch (err) {
      this.log(`memory: applying a message failed (${(err as Error).message}); will try again`);
      return 'retry';
    }
  }

  /** Returns true when handling it restarted the stream, so the rest of the batch is stale. */
  private async handle(payload: Payload, time: number): Promise<boolean> {
    switch (payload.kind) {
      case 'snapshot_request':
        if (payload.from !== this.device && this.ready && time >= this.serverNow() - 60) this.answerLater(payload.id);
        return false;
      case 'snapshot':
        this.answered.add(payload.requestId);
        if (this.awaiting?.id !== payload.requestId) return false;
        this.adopt(payload);
        return true;
      case 'changes':
        if (!this.ready) return false;
        if (this.state.seen[payload.id] !== undefined) return false; // a replay, or a retried publish
        // Older than any id we remember: a message posted again, never a live one.
        if (payload.cursor < time - DIGEST_HISTORY_SECONDS) {
          this.log(`memory: ignored a change from ${payload.from} made against second ${payload.cursor}, which is too old`);
          return false;
        }
        if (payload.from !== this.device && this.drifted(payload)) {
          await this.requestSnapshot();
          return true;
        }
        this.applyChanges(payload, time);
        this.state.seen[payload.id] = time;
        this.behind = true;
        this.save();
        return false;
    }
  }

  /**
   * True when the sender's shadows at its cursor differ from ours at that
   * second. Only the machine with the larger id asks for a snapshot, so two
   * drifted machines never wait on each other.
   */
  private drifted(payload: ChangesPayload): boolean {
    const mine = this.digestAt(payload.cursor);
    if (mine === undefined || mine === payload.digest) return false;
    if (this.device < payload.from || this.now() < this.driftUntil) return false;
    this.log(`memory: shadows differ from ${payload.from} at ${payload.cursor}; asking for a snapshot`);
    this.driftUntil = this.now() + DRIFT_COOLDOWN_MS;
    return true;
  }

  private applyChanges(payload: Extract<Payload, { kind: 'changes' }>, time: number): void {
    const touched = new Set<string>();
    const clashed: string[] = [];
    for (const change of payload.changes) {
      if (!isRepoKey(change.key) || !isMemoryFile(change.file)) continue;
      const { shared, shadow } = this.paths(change.key, change.file);
      const pendingKey = `${change.key}\n${change.file}`;
      const shadowBefore = read(shadow);
      const agreed = applyChange(change.base, shadowBefore, change.next);
      // Every machine gets the same clash; only its author reports it.
      if (agreed.clashed && payload.from === this.device) clashed.push(`${change.key}/${change.file}`);

      const local = read(shared);
      const pending = this.state.pending[pendingKey];
      let nextLocal: string | null;
      if (pending && local === pending.expected) {
        // Nobody edited the file since we last wrote or sent it.
        if (pending.id === payload.id) {
          nextLocal = agreed.text;
          delete this.state.pending[pendingKey];
        } else {
          nextLocal = applyChange(shadowBefore, local, agreed.text).text;
          pending.expected = nextLocal;
        }
      } else {
        if (pending?.id === payload.id) delete this.state.pending[pendingKey];
        const rebased = applyChange(shadowBefore, local, agreed.text);
        nextLocal = rebased.text;
        if (rebased.clashed) clashed.push(`${change.key}/${change.file}`);
      }

      if (shadowBefore !== agreed.text) put(shadow, agreed.text);
      if (local !== nextLocal) {
        put(shared, nextLocal);
        touched.add(change.key);
      }
      if (!this.state.keys.includes(change.key)) this.state.keys.push(change.key);
    }
    this.recordDigest(time);
    this.reportClashes(clashed);
    this.changed(touched);
  }

  /** Carry changed shared folders into their replicas. A failure waits for the next local pass, which retries it. */
  private changed(keys: Set<string>): void {
    if (keys.size === 0) return;
    try {
      this.options.onChanged?.([...keys]);
    } catch (err) {
      this.log(`memory: updating replicas failed (${(err as Error).message}); the next local pass retries`);
    }
  }

  // ---------------------------------------------------------------- snapshots

  /** Ask the live machines for their shadows. With no answer, carry on from what the topic holds. */
  private async requestSnapshot(): Promise<void> {
    if (this.awaiting || this.stopped) return;
    const id = newId();
    const timer = setTimeout(() => {
      // Through the queue, so a drain never sees the wait end half way through.
      this.queue = this.queue.then(() => {
        if (this.awaiting?.id !== id) return;
        this.awaiting = null;
        if (this.state.cursor === null) {
          this.log('memory: no peer answered; starting from what the topic still holds');
          this.state.cursor = 0;
          this.recordDigest(0);
        }
        this.save();
        this.restart();
      }).catch(err => this.log(`memory: ${(err as Error).message}`));
    }, this.options.snapshotWaitMs ?? 20_000);
    timer.unref();
    this.awaiting = { id, timer };
    this.restart();
    try {
      await this.wire.publish({ kind: 'snapshot_request', id, from: this.device });
    } catch (err) {
      this.log(`memory: snapshot request failed: ${(err as Error).message}`);
    }
  }

  private answerLater(requestId: string): void {
    const delay = this.options.answerDelayMs?.() ?? Math.floor(Math.random() * 5_000);
    setTimeout(() => {
      // Built in the queue, so shadows, cursor and seen ids describe one moment between two drains.
      this.queue = this.queue.then(() => {
        if (this.answered.has(requestId) || !this.ready || this.behind || this.stopped) return;
        this.answered.add(requestId);
        const shadows: Record<string, Record<string, string>> = {};
        for (const key of this.state.keys) {
          for (const file of memoryFiles(this.shadowDir(key))) {
            const text = read(path.join(this.shadowDir(key), file));
            if (text !== null) (shadows[key] ??= {})[file] = text;
          }
        }
        const snapshot: Payload = {
          kind: 'snapshot', id: newId(), from: this.device, requestId,
          cursor: this.state.cursor!, digest: this.digest(), shadows, seen: { ...this.state.seen },
        };
        this.wire.publish(snapshot).catch(err => this.log(`memory: snapshot answer failed: ${(err as Error).message}`));
      }).catch(err => this.log(`memory: snapshot answer failed: ${(err as Error).message}`));
    }, delay).unref();
  }

  /**
   * Take a peer's shadows as the agreed state. Local edits are kept: each
   * shared file is rebased from our old shadow onto theirs, so whatever we
   * changed goes out again on the next tick. A file the peer lacks is unknown
   * to it, not deleted (it may have joined after the file was last sent), so
   * ours stays and goes out again as new.
   */
  private adopt(snapshot: Extract<Payload, { kind: 'snapshot' }>): void {
    clearTimeout(this.awaiting!.timer);
    this.awaiting = null;
    const keys = [...new Set([...this.state.keys, ...Object.keys(snapshot.shadows).filter(isRepoKey)])];
    const touched = new Set<string>();
    const clashed: string[] = [];
    for (const key of keys) {
      const theirs = snapshot.shadows[key] ?? {};
      const names = new Set([...this.files(key), ...Object.keys(theirs).filter(isMemoryFile)]);
      for (const file of names) {
        const { shared, shadow } = this.paths(key, file);
        const before = read(shadow);
        const local = read(shared);
        const agreed = typeof theirs[file] === 'string' ? theirs[file] : null;
        const rebased = agreed === null ? { text: local, clashed: false } : applyChange(before, local, agreed);
        if (rebased.clashed) clashed.push(`${key}/${file}`);
        put(shadow, agreed);
        if (local !== rebased.text) {
          put(shared, rebased.text);
          touched.add(key);
        }
      }
    }
    this.state.keys = keys.filter(key => Object.keys(snapshot.shadows).includes(key) || this.files(key).length > 0);
    this.state.cursor = snapshot.cursor;
    this.state.pending = {};
    this.state.digests = [];
    // Their history now, so a replay from their cursor skips what their shadows already hold.
    this.state.seen = Object.fromEntries(
      Object.entries(snapshot.seen ?? {}).filter(([, second]) => typeof second === 'number'),
    );
    this.behind = false;
    this.recordDigest(snapshot.cursor);
    if (this.digest() !== snapshot.digest) this.log('memory: adopted snapshot does not match its digest');
    this.save();
    this.log(`memory: adopted a snapshot from ${snapshot.from} at ${snapshot.cursor}`);
    this.reportClashes(clashed);
    this.changed(touched);
    this.restart();
  }

  // ---------------------------------------------------------------- state

  private paths(key: string, file: string) {
    return { shared: path.join(sharedDir(key, this.root), file), shadow: path.join(this.shadowDir(key), file) };
  }

  private shadowDir(key: string): string {
    return path.join(syncDir(key, this.root), 'remote');
  }

  /** Memory files on either side of a repo. */
  private files(key: string): string[] {
    return [...new Set([...memoryFiles(sharedDir(key, this.root)), ...memoryFiles(this.shadowDir(key))])].sort();
  }

  /** A hash of every remote shadow. Equal on two machines means they agree. */
  private digest(): string {
    const h = createHash('sha256');
    for (const key of [...this.state.keys].sort()) {
      for (const file of memoryFiles(this.shadowDir(key)).sort()) {
        h.update(`${key}\0${file}\0${hash(read(path.join(this.shadowDir(key), file)) ?? '')}\n`);
      }
    }
    return h.digest('hex').slice(0, 16);
  }

  private recordDigest(second: number): void {
    const digests = this.state.digests.filter(([s]) => s < second);
    digests.push([second, this.digest()]);
    // Keep the history window, plus the last entry before it, which still covers the window's start.
    const cut = digests.findIndex(([s]) => s >= second - DIGEST_HISTORY_SECONDS);
    this.state.digests = digests.slice(Math.max(0, cut - 1));
  }

  /** Drop seen ids older than the history window; anything that old is refused as too old anyway. */
  private forget(): void {
    const cut = this.state.cursor! - DIGEST_HISTORY_SECONDS;
    for (const [id, second] of Object.entries(this.state.seen)) {
      if (second < cut) delete this.state.seen[id];
    }
  }

  private digestAt(second: number): string | undefined {
    let found: string | undefined;
    for (const [s, digest] of this.state.digests) {
      if (s > second) break;
      found = digest;
    }
    return found;
  }

  private reportClashes(files: string[]): void {
    for (const file of files) {
      this.options.notify?.(`clash:${file}`, 'Memory kept both versions',
        `Two machines changed the same lines of \`${file}\`. Both versions are in the file; tidy it when convenient.`);
    }
  }

  private get stateFile(): string {
    return path.join(this.root, '.sync', 'remote.json');
  }

  private load(): RemoteState {
    const saved = read(this.stateFile);
    const fresh: RemoteState = {
      device: randomBytes(8).toString('hex'), cursor: null, lastSeen: 0, keys: [], digests: [], pending: {}, seen: {},
    };
    if (!saved) return fresh;
    try {
      return { ...fresh, ...(JSON.parse(saved) as Partial<RemoteState>) };
    } catch {
      return fresh;
    }
  }

  /**
   * Persist the cursor and bookkeeping when they changed. A failed write is
   * logged and retried by the next call, never thrown: this runs from timers
   * and fire-and-forget ticks, where a throw would end the whole server.
   */
  save(): void {
    const text = JSON.stringify(this.state, null, 2);
    if (text === this.saved) return;
    try {
      atomicWrite(this.stateFile, text);
      this.saved = text;
    } catch (err) {
      this.log(`memory: saving sync state failed: ${(err as Error).message}`);
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private nowSec(): number {
    return Math.floor(this.now() / 1000);
  }

  private log(message: string): void {
    (this.options.log ?? console.error)(message);
  }
}

const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);
const newId = () => randomBytes(12).toString('hex');
/** Names arrive from other machines; only plain top-level `.md` names may become paths. */
const isMemoryFile = (file: string) => /^[^\\/:*?"<>|\x00-\x1f]{1,200}\.md$/i.test(file) && !file.startsWith('.');
/** A repo key as `repoKeyFromOrigin` makes it: lowercase segments, never `.` or `..`. */
const isRepoKey = (key: string) =>
  /^[a-z0-9._-]+(\/[a-z0-9._-]+)+$/.test(key) && !key.split('/').some(part => part === '.' || part === '..');
const defaultLocalKeys = () => Object.keys(readRegistry());
