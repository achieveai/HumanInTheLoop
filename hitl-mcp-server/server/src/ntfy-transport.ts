import { randomBytes } from 'crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import type {
  QuestionMessage,
  AnswerMessage,
  HitlMessage,
  PlanMessage,
  AnyHitlMessage,
  AttachmentRef,
  HitlConfig,
} from './types.js';
import { encrypt, decrypt, isEncryptedEnvelope } from './crypto.js';
import { shouldChunk, splitIntoChunks } from './chunking.js';
import { assertNoChunk } from './payload.js';

/**
 * Pull ntfy's own attachment metadata off a raw event.
 *
 * Shape confirmed live against ntfy.sh:
 *   {"name":"…","type":"application/octet-stream","size":5000,
 *    "expires":1786514937,"url":"https://ntfy.sh/file/qurRQchLV1Fb.bin"}
 *
 * This is plaintext metadata outside our encryption — `name` echoes the
 * Filename header, so senders must use random hex there and never a real path.
 */
export function parseAttachment(ntfyEvent: unknown): AttachmentRef | undefined {
  const att = (ntfyEvent as { attachment?: Record<string, unknown> } | null)?.attachment;
  if (!att || typeof att.url !== 'string') return undefined;

  return {
    name: typeof att.name === 'string' ? att.name : '',
    url: att.url,
    type: typeof att.type === 'string' ? att.type : undefined,
    size: typeof att.size === 'number' ? att.size : undefined,
    expires: typeof att.expires === 'number' ? att.expires : undefined,
  };
}

// -----------------------------------------------------------
// ntfy error classification
//
// Verified live: the error envelope is
//   {"code":42901,"http":429,"error":"…","link":"…"}
// where `code` is <http-status><2-digit subcode>. An oversized X-Message is
// answered by the nginx in front of ntfy with an HTML body instead, so nothing
// here may assume the body parses as JSON.
// -----------------------------------------------------------

/** 429 subcodes that a delay can actually clear. */
const RETRYABLE_NTFY_CODES = new Set([
  42901, // too many requests — burst / visitor throttle
  42911, // too many new topics, please wait
]);

/** Codes where retrying is pointless; the reason names how to actually recover. */
const FATAL_NTFY_CODES = new Map<number, string>([
  [42908, 'daily ntfy message quota reached — resets at UTC midnight, or self-host'],
  [42905, 'daily ntfy attachment bandwidth reached — resets at UTC midnight, or self-host'],
  [42903, 'too many active ntfy subscriptions for this IP'],
  [41301, 'attachment rejected by ntfy as oversized'],
]);

/** Raised when publishing failed and retrying cannot help. */
export class NtfyPublishError extends Error {
  constructor(message: string, readonly status: number, readonly code?: number) {
    super(message);
    this.name = 'NtfyPublishError';
  }
}

/** Raised when the X-Message header would exceed the proxy's header buffer. */
export class XMessageTooLargeError extends Error {
  constructor(readonly byteLength: number) {
    super(
      `Plan metadata header is ${byteLength} bytes, over the ${X_MESSAGE_MAX_BYTES}-byte limit. ` +
        `ntfy sits behind an nginx whose header buffer is 8 KB; this cap is half of it.`
    );
    this.name = 'XMessageTooLargeError';
  }
}

/** Raised when an attachment URL 404s — ntfy expires attachments after 3 h. */
export class AttachmentExpiredError extends Error {
  constructor(readonly url: string) {
    super(`Attachment has expired or was never stored: ${url}`);
    this.name = 'AttachmentExpiredError';
  }
}

/**
 * Half of nginx's default 8 KB `large_client_header_buffers`. Measured live:
 * 7317 bytes still returned 200, 16317 returned an nginx 400. Our encrypted
 * metadata runs ~600–900 bytes, so this is a wide margin against proxies with
 * smaller defaults rather than a tight fit.
 */
export const X_MESSAGE_MAX_BYTES = 4096;

/** What a failed publish should do next. */
export interface NtfyErrorClassification {
  retryable: boolean;
  /** ntfy's numeric subcode, absent when the body was not ntfy's JSON envelope. */
  code?: number;
  message: string;
}

/**
 * Decide whether a failed publish is worth retrying.
 *
 * Unknown 429s are treated as retryable — the burst throttle is the common case
 * and it clears on its own. Everything else in the 4xx range is a request the
 * server will reject identically forever.
 */
export function classifyNtfyError(status: number, body: string): NtfyErrorClassification {
  let code: number | undefined;
  let detail = body.trim().slice(0, 500);

  try {
    const parsed = JSON.parse(body) as { code?: unknown; error?: unknown };
    if (typeof parsed.code === 'number') code = parsed.code;
    if (typeof parsed.error === 'string') detail = parsed.error;
  } catch {
    // nginx answers an oversized header with HTML. Keep the raw text.
  }

  if (code !== undefined) {
    const fatal = FATAL_NTFY_CODES.get(code);
    if (fatal) {
      return { retryable: false, code, message: `${fatal} (ntfy ${code}: ${detail})` };
    }
    if (RETRYABLE_NTFY_CODES.has(code)) {
      return { retryable: true, code, message: `ntfy ${code}: ${detail}` };
    }
  }

  if (status === 429) {
    return {
      retryable: true,
      code,
      message:
        `ntfy returned 429 with no recognizable code — treating as a burst throttle. ` +
        `If this persists it may be the daily quota, which resets at UTC midnight. Body: ${detail}`,
    };
  }
  if (status >= 500) {
    return { retryable: true, code, message: `ntfy server error ${status}: ${detail}` };
  }

  return { retryable: false, code, message: `ntfy rejected the request (${status}): ${detail}` };
}

// -----------------------------------------------------------
// Retry and reconnect policy
// -----------------------------------------------------------

export interface RetryPolicy {
  maxAttempts: number;
  totalBudgetMs: number;
  initialDelayMs: number;
  maxDelayMs: number;
}

export interface SubscriptionPolicy {
  initialBackoffMs: number;
  maxBackoffMs: number;
  /** A connection that survives this long resets the backoff ladder. */
  healthyConnectionMs: number;
}

const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 5,
  totalBudgetMs: 60_000,
  initialDelayMs: 500,
  maxDelayMs: 8_000,
};

const DEFAULT_SUBSCRIPTION: SubscriptionPolicy = {
  initialBackoffMs: 1_000,
  maxBackoffMs: 30_000,
  healthyConnectionMs: 5_000,
};

/** Test seams. Production callers pass nothing. */
export interface TransportOptions {
  retry?: Partial<RetryPolicy>;
  subscription?: Partial<SubscriptionPolicy>;
}

// -----------------------------------------------------------
// Outstanding-wait persistence (D-8)
// -----------------------------------------------------------

/** One outstanding wait, durable across a server restart. */
export interface PendingEntry {
  kind: 'question' | 'plan_review';
  /** messageId of the published question / plan_review. */
  id: string;
  /** plan_review only: what makes a retry recognizable as the same review. */
  planId?: string;
  snapshotHash?: string;
  createdAt: number;
}

/**
 * Records what this process is still waiting for, at `~/.hitl/pending/<pid>.json`.
 *
 * `waitForAnswer` streams forward-only, so a server that dies mid-wait loses the
 * answer permanently even though ntfy holds it for 12 h. Persisting the
 * outstanding IDs lets a restarted process recognize a retried review as the
 * same one and pull the already-submitted response out of the cache instead of
 * asking the human again (D-8).
 */
export class PendingStore {
  private readonly dir: string;
  private readonly file: string;
  private entries: PendingEntry[] = [];

  constructor(private readonly pid: number = process.pid) {
    this.dir = path.join(process.env.HITL_HOME ?? path.join(homedir(), '.hitl'), 'pending');
    this.file = path.join(this.dir, `${pid}.json`);
  }

  record(entry: PendingEntry): void {
    this.entries = this.entries.filter((e) => e.id !== entry.id);
    this.entries.push(entry);
    this.flush();
  }

  clear(id: string): void {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== id);
    if (this.entries.length !== before) this.flush();
  }

  /**
   * Find a still-unanswered review of the same plan at the same content hash,
   * left behind by this or an earlier process. Reusing its reviewId means a
   * review window that is still open on the human's device resolves this call.
   */
  findResumableReview(planId: string, snapshotHash: string): PendingEntry | undefined {
    for (const entry of this.readAll()) {
      if (entry.kind === 'plan_review' && entry.planId === planId && entry.snapshotHash === snapshotHash) {
        return entry;
      }
    }
    return undefined;
  }

  /** Every entry on disk, this process's and any predecessor's. */
  readAll(): PendingEntry[] {
    if (!existsSync(this.dir)) return [];

    const all: PendingEntry[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(readFileSync(path.join(this.dir, name), 'utf8')) as unknown;
        if (Array.isArray(parsed)) all.push(...(parsed as PendingEntry[]));
      } catch {
        // A truncated file from a killed process is not worth failing a call over.
      }
    }
    return all;
  }

  private flush(): void {
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      if (this.entries.length === 0) {
        if (existsSync(this.file)) unlinkSync(this.file);
        return;
      }
      writeFileSync(this.file, JSON.stringify(this.entries, null, 2) + '\n', {
        encoding: 'utf8',
        mode: 0o600,
      });
    } catch (err) {
      // Losing durability degrades D-8 to "no resume"; it must not fail the call.
      console.error(`Could not persist pending waits for pid ${this.pid}: ${err}`);
    }
  }
}

// -----------------------------------------------------------
// Transport
// -----------------------------------------------------------

/** A message as it came off the wire, with the ntfy event's attachment metadata. */
export interface ReceivedMessage<T extends AnyHitlMessage = AnyHitlMessage> {
  msg: T;
  attachment?: AttachmentRef;
}

export type MessageMatcher = (msg: AnyHitlMessage) => boolean;

interface Waiter {
  match: MessageMatcher;
  resolve: (received: ReceivedMessage) => void;
  reject: (err: unknown) => void;
}

interface Watcher {
  match: MessageMatcher;
  handle: (received: ReceivedMessage) => void;
}

/** Cap on remembered messageIds. Only guards against a reconnect replaying events. */
const SEEN_IDS_LIMIT = 512;

/**
 * Transport layer for communicating with ntfy.sh.
 *
 * One SSE subscription is shared by every outstanding wait and ref-counted, so
 * a ReviewPlan and an AskUserQuestion running in the same agent turn resolve
 * over a single connection (C-9) instead of clobbering each other's
 * AbortController. The subscription reconnects on clean end as well as on
 * error, resuming from the last event timestamp (C-8).
 */
export class NtfyTransport {
  private config: HitlConfig;
  private waiters = new Map<string, Waiter>();
  private watchers = new Map<string, Watcher>();
  private subscriptionAbort: AbortController | null = null;
  private subscriptionRefs = 0;
  /** Unix seconds. Where a reconnect resumes from. */
  private lastEventTs = 0;
  private seenIds: string[] = [];
  private seenSet = new Set<string>();
  private readonly retry: RetryPolicy;
  private readonly subscriptionPolicy: SubscriptionPolicy;
  readonly pending: PendingStore;

  constructor(config: HitlConfig, options: TransportOptions = {}) {
    this.config = config;
    this.retry = { ...DEFAULT_RETRY, ...options.retry };
    this.subscriptionPolicy = { ...DEFAULT_SUBSCRIPTION, ...options.subscription };
    this.pending = new PendingStore();
  }

  /** Full URL for the ntfy topic. */
  private get topicUrl(): string {
    const base = this.config.ntfyUrl.replace(/\/+$/, '');
    return `${base}/${this.config.topicId}`;
  }

  /**
   * Publish one of the four shipping message types.
   *
   * Their wire format is frozen: plain JSON, optionally encrypted, chunked when
   * oversized. The type signature is what keeps a plan message off this path —
   * a chunked plan_review would break the one-message-per-review guarantee.
   */
  async publish(msg: HitlMessage): Promise<void> {
    let body: string;
    if (this.config.encryptionKey) {
      body = encrypt(JSON.stringify(msg), this.config.encryptionKey);
    } else {
      body = JSON.stringify(msg);
    }

    if (!shouldChunk(body)) {
      await this.publishRaw(body);
      return;
    }

    for (const chunk of splitIntoChunks(body, msg.messageId)) {
      await this.publishRaw(JSON.stringify(chunk));
    }
  }

  /**
   * Publish a plan-review message. Never chunks.
   *
   * When `attachmentCipher` is given, the outer message rides along in the
   * `X-Message` header of the attachment PUT, so a plan of any size is still
   * exactly one ntfy message (C-1).
   */
  async publishPlan(msg: PlanMessage, attachmentCipher?: string): Promise<void> {
    const body = this.config.encryptionKey
      ? encrypt(JSON.stringify(msg), this.config.encryptionKey)
      : JSON.stringify(msg);

    assertNoChunk(body);

    if (attachmentCipher === undefined) {
      await this.publishRaw(body);
      return;
    }

    await this.uploadAttachment(attachmentCipher, body);
  }

  /**
   * PUT the payload as an ntfy attachment with the outer message in `X-Message`.
   *
   * The filename is random hex: ntfy echoes it verbatim as plaintext metadata
   * on the event, outside our encryption, so a real path there would leak the
   * absolute location of the plan (F-9).
   */
  async uploadAttachment(cipher: string, outerJson: string): Promise<void> {
    const headerBytes = Buffer.byteLength(outerJson, 'utf8');
    if (headerBytes > X_MESSAGE_MAX_BYTES) {
      throw new XMessageTooLargeError(headerBytes);
    }
    // JSON.stringify emits no literal newlines, but a stray CR/LF in a header
    // is a request-splitting bug rather than a size error — check it explicitly.
    if (/[\r\n]/.test(outerJson)) {
      throw new NtfyPublishError('Plan metadata contains a line break and cannot be sent as a header', 0);
    }

    await this.fetchWithRetry(
      this.topicUrl,
      {
        method: 'PUT',
        headers: {
          Filename: `${randomBytes(12).toString('hex')}.bin`,
          'X-Message': outerJson,
        },
        body: cipher,
      },
      'upload plan attachment'
    );
  }

  /**
   * Fetch an attachment's bytes.
   *
   * A 404 is its own error: ntfy expires attachments after 3 h while keeping
   * messages for 12 h, so a replayed review routinely points at a dead URL and
   * the caller must be able to say "expired" rather than "failed" (C-4/C-12).
   */
  async downloadAttachment(ref: AttachmentRef, signal?: AbortSignal): Promise<string> {
    const response = await fetch(ref.url, { signal });

    if (response.status === 404 || response.status === 410) {
      throw new AttachmentExpiredError(ref.url);
    }
    if (!response.ok) {
      throw new NtfyPublishError(
        `Failed to download attachment ${ref.url}: ${response.status} ${response.statusText}`,
        response.status
      );
    }

    return await response.text();
  }

  /** POST a single raw body string to the ntfy topic. */
  private async publishRaw(body: string): Promise<void> {
    await this.fetchWithRetry(
      this.topicUrl,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body },
      'publish message'
    );
  }

  /**
   * Send a request, retrying only the failures a delay can clear.
   *
   * Capped at 5 attempts and a 60 s total budget: past that the cause is
   * structural, and spinning against a daily quota that resets at UTC midnight
   * would block the agent for hours (C-13). `Retry-After` is honoured when
   * present — it was absent on every probed ntfy response, so it is read
   * opportunistically and never required.
   */
  private async fetchWithRetry(url: string, init: RequestInit, describe: string): Promise<Response> {
    const startedAt = Date.now();
    let delayMs = this.retry.initialDelayMs;
    let lastMessage = '';

    for (let attempt = 1; attempt <= this.retry.maxAttempts; attempt++) {
      let response: Response;
      try {
        response = await fetch(url, init);
      } catch (err) {
        // A transport-level failure (DNS, refused, reset) is worth a retry.
        lastMessage = `${(err as Error).message}`;
        if (attempt === this.retry.maxAttempts || Date.now() - startedAt >= this.retry.totalBudgetMs) {
          throw new NtfyPublishError(`Failed to ${describe}: ${lastMessage}`, 0);
        }
        await sleep(nextDelay(delayMs, this.retry.maxDelayMs));
        delayMs = Math.min(delayMs * 2, this.retry.maxDelayMs);
        continue;
      }

      if (response.ok) return response;

      const body = await safeText(response);
      const verdict = classifyNtfyError(response.status, body);
      lastMessage = verdict.message;
      console.error(`ntfy ${describe} attempt ${attempt} failed: ${verdict.message}`);

      if (!verdict.retryable) {
        throw new NtfyPublishError(`Failed to ${describe}: ${verdict.message}`, response.status, verdict.code);
      }

      const elapsed = Date.now() - startedAt;
      if (attempt === this.retry.maxAttempts || elapsed >= this.retry.totalBudgetMs) break;

      const retryAfterMs = parseRetryAfter(response.headers?.get?.('retry-after'));
      const wait = Math.min(
        retryAfterMs ?? nextDelay(delayMs, this.retry.maxDelayMs),
        Math.max(0, this.retry.totalBudgetMs - elapsed)
      );
      await sleep(wait);
      delayMs = Math.min(delayMs * 2, this.retry.maxDelayMs);
    }

    throw new NtfyPublishError(
      `Failed to ${describe} after ${this.retry.maxAttempts} attempts: ${lastMessage}`,
      429
    );
  }

  /** @deprecated Use publish() instead */
  async publishQuestion(msg: QuestionMessage): Promise<void> {
    return this.publish(msg);
  }

  /** @deprecated Use publish() instead */
  async publishAnswer(msg: AnswerMessage): Promise<void> {
    return this.publish(msg);
  }

  /**
   * Wait for the first message satisfying `match`.
   *
   * `key` identifies the waiter so overlapping calls cannot clobber one another
   * (C-9). The cache is replayed once at registration, after the live stream is
   * already attached, so a response published while this process was down or
   * reconnecting still resolves the call (D-8).
   *
   * `signal` releases the SSE connection and the waiter within one tick of
   * cancellation, which is what stops a stopped tool call leaking a connection
   * for the life of the process (D-9).
   */
  waitFor<T extends AnyHitlMessage>(
    key: string,
    match: MessageMatcher,
    signal?: AbortSignal
  ): Promise<ReceivedMessage<T>> {
    return new Promise<ReceivedMessage<T>>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new AbortedWaitError(key));
        return;
      }

      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        this.waiters.delete(key);
        signal?.removeEventListener('abort', onAbort);
        this.releaseSubscription();
        fn();
      };

      const onAbort = () => finish(() => reject(new AbortedWaitError(key)));
      signal?.addEventListener('abort', onAbort);

      this.waiters.set(key, {
        match,
        resolve: (received) => finish(() => resolve(received as ReceivedMessage<T>)),
        reject: (err) => finish(() => reject(err)),
      });

      this.acquireSubscription();

      // Replay after the stream is attached, so nothing can slip through the
      // gap between the poll returning and the stream connecting.
      void this.replayCache(match)
        .then((received) => {
          if (received) this.deliver(received);
        })
        .catch((err) => {
          console.error(`Cache replay for ${key} failed: ${err}`);
        });
    });
  }

  /**
   * Observe matching messages without consuming them, until the returned
   * function is called.
   *
   * Unlike a waiter, a watcher fires repeatedly and only sees what no waiter
   * took — which is exactly the shape of "a second device submitted after the
   * first one already won" (D-5). It holds the subscription open while
   * registered.
   */
  watch(key: string, match: MessageMatcher, handle: (received: ReceivedMessage) => void): () => void {
    this.watchers.set(key, { match, handle });
    this.acquireSubscription();

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.watchers.delete(key);
      this.releaseSubscription();
    };
  }

  /**
   * Subscribe and wait for an answer to a specific question.
   *
   * A thin wrapper over waitFor so the shipping AskUserQuestion path behaves
   * exactly as before, minus the timeout (D-1).
   */
  async waitForAnswer(questionId: string, signal?: AbortSignal): Promise<AnswerMessage> {
    const received = await this.waitFor<AnswerMessage>(
      `answer:${questionId}`,
      (msg) => msg.type === 'answer' && msg.questionId === questionId,
      signal
    );
    return received.msg;
  }

  /**
   * Poll ntfy's message cache for an already-published match.
   *
   * `since=all` reaches back the full 12 h retention, which is the window in
   * which a response can have been submitted while this process was gone.
   */
  async replayCache(match: MessageMatcher, since = 'all'): Promise<ReceivedMessage | undefined> {
    const url = `${this.topicUrl}/json?poll=1&since=${since}`;
    const response = await fetch(url, { headers: { Accept: 'application/x-ndjson' } });

    if (!response.ok) {
      throw new NtfyPublishError(
        `ntfy cache poll failed: ${response.status} ${response.statusText}`,
        response.status
      );
    }

    for (const line of (await response.text()).split('\n')) {
      const received = this.parseEventLine(line);
      if (received && match(received.msg)) return received;
    }
    return undefined;
  }

  /** Join the shared subscription, starting it if this is the first waiter. */
  private acquireSubscription(): void {
    this.subscriptionRefs++;
    if (this.subscriptionAbort) return;

    if (this.lastEventTs === 0) this.lastEventTs = Math.floor(Date.now() / 1000);

    const controller = new AbortController();
    this.subscriptionAbort = controller;
    void this.runSubscription(controller.signal);
  }

  /** Leave the shared subscription, closing it when the last waiter goes. */
  private releaseSubscription(): void {
    this.subscriptionRefs = Math.max(0, this.subscriptionRefs - 1);
    if (this.subscriptionRefs === 0 && this.subscriptionAbort) {
      this.subscriptionAbort.abort();
      this.subscriptionAbort = null;
    }
  }

  /**
   * Keep one stream attached until every waiter is gone.
   *
   * A clean stream end is treated exactly like an error: ntfy closes idle
   * connections routinely, and the previous code resolved the read loop on
   * close so the wait simply never completed (C-8).
   */
  private async runSubscription(signal: AbortSignal): Promise<void> {
    let backoff = this.subscriptionPolicy.initialBackoffMs;

    while (!signal.aborted) {
      const connectedAt = Date.now();
      try {
        await this.startSSEListener(
          `${this.topicUrl}/json?since=${this.lastEventTs}`,
          signal,
          (msg, attachment) => this.deliver({ msg, attachment })
        );
      } catch (err) {
        if (signal.aborted) return;
        console.error(`ntfy subscription error, reconnecting: ${(err as Error).message}`);
      }

      if (signal.aborted) return;

      if (Date.now() - connectedAt >= this.subscriptionPolicy.healthyConnectionMs) {
        backoff = this.subscriptionPolicy.initialBackoffMs;
      }
      await sleep(backoff, signal);
      backoff = Math.min(backoff * 2, this.subscriptionPolicy.maxBackoffMs);
    }
  }

  /** Hand a message to the first waiter that wants it, ignoring replays. */
  private deliver(received: ReceivedMessage): void {
    const id = received.msg.messageId;
    if (id) {
      if (this.seenSet.has(id)) return;
      this.seenSet.add(id);
      this.seenIds.push(id);
      if (this.seenIds.length > SEEN_IDS_LIMIT) {
        const evicted = this.seenIds.shift();
        if (evicted) this.seenSet.delete(evicted);
      }
    }

    for (const [key, waiter] of this.waiters) {
      if (waiter.match(received.msg)) {
        this.waiters.delete(key);
        waiter.resolve(received);
        return;
      }
    }

    // Only what no waiter claimed reaches the watchers.
    for (const watcher of [...this.watchers.values()]) {
      if (watcher.match(received.msg)) watcher.handle(received);
    }
  }

  /**
   * Turn one line of ntfy's ndjson stream into a HITL message.
   *
   * Also advances `lastEventTs`, including for keepalives — that is what lets a
   * reconnect resume from where the stream stopped rather than from process
   * start.
   */
  private parseEventLine(line: string): ReceivedMessage | undefined {
    const trimmed = line.trim();
    if (!trimmed) return undefined;

    let ntfyEvent: { message?: unknown; time?: unknown };
    try {
      ntfyEvent = JSON.parse(trimmed);
    } catch {
      return undefined; // Not valid JSON, ignore
    }

    if (typeof ntfyEvent.time === 'number' && ntfyEvent.time > this.lastEventTs) {
      this.lastEventTs = ntfyEvent.time;
    }

    if (typeof ntfyEvent.message !== 'string') return undefined;

    try {
      const parsed = JSON.parse(ntfyEvent.message);
      let hitlMsg: AnyHitlMessage;

      if (isEncryptedEnvelope(parsed)) {
        if (!this.config.encryptionKey) {
          console.error('Received encrypted message but no encryptionKey configured — skipping');
          return undefined;
        }
        try {
          hitlMsg = JSON.parse(decrypt(ntfyEvent.message, this.config.encryptionKey)) as AnyHitlMessage;
        } catch (decryptErr) {
          console.error('Failed to decrypt message:', decryptErr);
          return undefined;
        }
      } else {
        hitlMsg = parsed as AnyHitlMessage;
      }

      if (!hitlMsg?.type) return undefined;
      return { msg: hitlMsg, attachment: parseAttachment(ntfyEvent) };
    } catch {
      return undefined; // Not a valid HITL message, ignore
    }
  }

  /**
   * Open a streaming connection to ntfy and invoke the callback for each parsed HITL message.
   * Uses fetch streaming (works in Node 18+).
   *
   * `attachment` is the ntfy event's own attachment metadata, which only exists
   * on the event envelope — never inside our message, since the URL is assigned
   * by the PUT. Plan-review bodies over the inline threshold live there.
   */
  private async startSSEListener(
    url: string,
    signal: AbortSignal,
    onMessage: (msg: AnyHitlMessage, attachment?: AttachmentRef) => void
  ): Promise<void> {
    const response = await fetch(url, {
      headers: { Accept: 'application/x-ndjson' },
      signal,
    });

    if (!response.ok) {
      throw new Error(`ntfy subscription failed: ${response.status} ${response.statusText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body from ntfy');

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const received = this.parseEventLine(line);
          if (received) onMessage(received.msg, received.attachment);
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return;
      throw err;
    }
  }

  /**
   * Close any active subscriptions and fail every outstanding wait.
   */
  close(): void {
    this.subscriptionAbort?.abort();
    this.subscriptionAbort = null;
    this.subscriptionRefs = 0;
    this.watchers.clear();

    const waiters = [...this.waiters.values()];
    this.waiters.clear();
    for (const waiter of waiters) {
      waiter.reject(new Error('Transport closed'));
    }
  }
}

/** Raised when a wait is cancelled by its caller's AbortSignal. */
export class AbortedWaitError extends Error {
  constructor(readonly key: string) {
    super(`Wait for ${key} was cancelled`);
    this.name = 'AbortedWaitError';
  }
}

/** Full jitter, so concurrent servers behind one NAT do not retry in lockstep. */
function nextDelay(baseMs: number, maxMs: number): number {
  return Math.floor(Math.random() * Math.min(baseMs, maxMs));
}

function parseRetryAfter(header: string | null | undefined): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done);
  });
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
