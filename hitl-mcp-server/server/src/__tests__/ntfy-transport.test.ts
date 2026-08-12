import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { tmpdir } from 'os';
import path from 'path';
import {
  NtfyTransport,
  classifyNtfyError,
  parseAttachment,
  AttachmentExpiredError,
  XMessageTooLargeError,
  NtfyPublishError,
  AbortedWaitError,
  X_MESSAGE_MAX_BYTES,
} from '../ntfy-transport.js';
import type {
  HitlConfig,
  AnswerMessage,
  AnyHitlMessage,
  PlanReviewMessage,
  PlanReviewResponseMessage,
} from '../types.js';
import { PROTOCOL_VERSION } from '../types.js';

const CONFIG: HitlConfig = {
  topicId: 'topic-under-test',
  ntfyUrl: 'https://ntfy.sh',
  deviceName: 'test-device',
  soundEnabled: false,
};

/** Fast policy so a retry test costs milliseconds, not a minute. */
const FAST = {
  retry: { maxAttempts: 3, totalBudgetMs: 200, initialDelayMs: 1, maxDelayMs: 2 },
  subscription: { initialBackoffMs: 1, maxBackoffMs: 4, healthyConnectionMs: 5_000 },
};

function answerEvent(questionId: string, id = `ans-${questionId}`, time = 1_700_000_000): string {
  const msg: AnswerMessage = {
    type: 'answer',
    messageId: id,
    timestamp: 1_700_000_000_000,
    questionId,
    respondedFrom: 'Kay9',
    selectedValues: ['yes'],
    skipped: false,
  };
  return JSON.stringify({ id, time, event: 'message', message: JSON.stringify(msg) });
}

/** Event times must be in the future: the transport never rewinds `since`. */
function futureTs(offsetSeconds: number): number {
  return Math.floor(Date.now() / 1000) + offsetSeconds;
}

/** A response body that never closes, so the stream stays open until aborted. */
function openStream(lines: string[], onClose?: () => void) {
  let index = 0;
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    body: {
      getReader: () => ({
        read: async () => {
          if (index < lines.length) {
            return { done: false, value: new TextEncoder().encode(lines[index++] + '\n') };
          }
          // Park forever; the AbortSignal is what ends this in production.
          return await new Promise<{ done: boolean; value?: Uint8Array }>(() => {});
        },
        cancel: async () => { onClose?.(); },
      }),
    },
  } as unknown as Response;
}

/** A stream that yields its lines then ends cleanly — the C-8 case. */
function closingStream(lines: string[]) {
  let index = 0;
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    body: {
      getReader: () => ({
        read: async () => {
          if (index < lines.length) {
            return { done: false, value: new TextEncoder().encode(lines[index++] + '\n') };
          }
          return { done: true, value: undefined };
        },
        cancel: async () => {},
      }),
    },
  } as unknown as Response;
}

function pollResponse(lines: string[]) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => lines.join('\n'),
  } as unknown as Response;
}

function errorResponse(status: number, body: string, headers: Record<string, string> = {}) {
  return {
    ok: false,
    status,
    statusText: 'Error',
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => body,
  } as unknown as Response;
}

describe('classifyNtfyError', () => {
  it('retries the burst throttle and the new-topic throttle', () => {
    for (const code of [42901, 42911]) {
      const verdict = classifyNtfyError(429, JSON.stringify({ code, http: 429, error: 'limit reached' }));
      expect(verdict.retryable).toBe(true);
      expect(verdict.code).toBe(code);
    }
  });

  it('fails fast on the daily quota rather than spinning until UTC midnight (C-13)', () => {
    const verdict = classifyNtfyError(
      429,
      JSON.stringify({ code: 42908, http: 429, error: 'limit reached: daily message quota reached' })
    );

    expect(verdict.retryable).toBe(false);
    expect(verdict.message).toMatch(/UTC midnight/);
  });

  it('fails fast on daily bandwidth and on an oversized attachment', () => {
    expect(classifyNtfyError(429, JSON.stringify({ code: 42905 })).retryable).toBe(false);
    expect(classifyNtfyError(413, JSON.stringify({ code: 41301 })).retryable).toBe(false);
  });

  it('tolerates a non-JSON body — nginx answers an oversized header with HTML (D14)', () => {
    const html = '<html><head><title>400 Request Header Or Cookie Too Large</title></head></html>';
    const verdict = classifyNtfyError(400, html);

    expect(verdict.retryable).toBe(false);
    expect(verdict.code).toBeUndefined();
    expect(verdict.message).toContain('Request Header Or Cookie Too Large');
  });

  it('treats an unrecognized 429 as retryable but names the quota possibility', () => {
    const verdict = classifyNtfyError(429, 'rate limited');

    expect(verdict.retryable).toBe(true);
    expect(verdict.message).toMatch(/UTC midnight/);
  });

  it('never retries an ordinary 4xx', () => {
    expect(classifyNtfyError(400, JSON.stringify({ code: 40018, error: 'invalid' })).retryable).toBe(false);
    expect(classifyNtfyError(404, '').retryable).toBe(false);
  });

  it('retries 5xx', () => {
    expect(classifyNtfyError(503, 'upstream down').retryable).toBe(true);
  });
});

describe('parseAttachment', () => {
  it('reads ntfy\'s attachment metadata off the raw event', () => {
    const ref = parseAttachment({
      attachment: {
        name: 'probe.bin',
        type: 'application/octet-stream',
        size: 5000,
        expires: 1786514937,
        url: 'https://ntfy.sh/file/qurRQchLV1Fb.bin',
      },
    });

    expect(ref).toEqual({
      name: 'probe.bin',
      type: 'application/octet-stream',
      size: 5000,
      expires: 1786514937,
      url: 'https://ntfy.sh/file/qurRQchLV1Fb.bin',
    });
  });

  it('returns undefined when there is no attachment URL', () => {
    expect(parseAttachment({})).toBeUndefined();
    expect(parseAttachment({ attachment: { name: 'x' } })).toBeUndefined();
    expect(parseAttachment(null)).toBeUndefined();
  });
});

describe('NtfyTransport', () => {
  const realFetch = globalThis.fetch;
  const originalHome = process.env.HITL_HOME;
  let transport: NtfyTransport;

  beforeEach(() => {
    // Keep the pending store off the developer's real ~/.hitl.
    process.env.HITL_HOME = path.join(tmpdir(), 'hitl-transport-test');
  });

  afterEach(() => {
    transport?.close();
    globalThis.fetch = realFetch;
    if (originalHome === undefined) delete process.env.HITL_HOME;
    else process.env.HITL_HOME = originalHome;
  });

  it('resolves two concurrent waits over a single stream (C-9)', async () => {
    let streamOpens = 0;
    globalThis.fetch = jest.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes('poll=1')) return pollResponse([]);
      streamOpens++;
      return openStream([answerEvent('q-one'), answerEvent('q-two')]);
    }) as unknown as typeof fetch;

    transport = new NtfyTransport(CONFIG, FAST);
    const [one, two] = await Promise.all([
      transport.waitForAnswer('q-one'),
      transport.waitForAnswer('q-two'),
    ]);

    expect(one.questionId).toBe('q-one');
    expect(two.questionId).toBe('q-two');
    expect(streamOpens).toBe(1);
  });

  it('reconnects from the last event timestamp after a clean stream end (C-8)', async () => {
    const streamUrls: string[] = [];
    const lastSeen = futureTs(500);
    globalThis.fetch = jest.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes('poll=1')) return pollResponse([]);
      streamUrls.push(u);
      // First connection delivers an unrelated event then closes cleanly.
      // Before this fix a clean close ended the read loop and the wait never
      // resolved at all.
      return streamUrls.length === 1
        ? closingStream([answerEvent('someone-else', 'other', lastSeen)])
        : openStream([answerEvent('mine')]);
    }) as unknown as typeof fetch;

    transport = new NtfyTransport(CONFIG, FAST);
    const answer = await transport.waitForAnswer('mine');

    expect(answer.questionId).toBe('mine');
    expect(streamUrls.length).toBeGreaterThanOrEqual(2);
    expect(streamUrls[1]).toContain(`since=${lastSeen}`);
  });

  it('resolves a pre-existing answer straight out of the cache (D-8)', async () => {
    const polled: string[] = [];
    globalThis.fetch = jest.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes('poll=1')) {
        polled.push(u);
        return pollResponse([answerEvent('already-answered')]);
      }
      return openStream([]);
    }) as unknown as typeof fetch;

    transport = new NtfyTransport(CONFIG, FAST);
    const answer = await transport.waitForAnswer('already-answered');

    expect(answer.respondedFrom).toBe('Kay9');
    expect(polled[0]).toContain('since=all');
  });

  it('delivers each messageId once even when a reconnect replays it', async () => {
    let opens = 0;
    globalThis.fetch = jest.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes('poll=1')) return pollResponse([answerEvent('dup')]);
      opens++;
      return openStream([answerEvent('dup')]);
    }) as unknown as typeof fetch;

    transport = new NtfyTransport(CONFIG, FAST);
    await transport.waitForAnswer('dup');

    // A second wait on the same id must not be satisfied by the replayed copy.
    const second = transport.waitForAnswer('dup', AbortSignal.timeout(60));
    await expect(second).rejects.toBeInstanceOf(AbortedWaitError);
    expect(opens).toBeGreaterThan(0);
  });

  it('releases the stream when the caller\'s signal aborts (D-9)', async () => {
    let streamSignal: AbortSignal | undefined;
    let opens = 0;
    globalThis.fetch = jest.fn(async (url: unknown, init: unknown) => {
      if (String(url).includes('poll=1')) return pollResponse([]);
      opens++;
      streamSignal = (init as RequestInit).signal ?? undefined;
      return openStream([]);
    }) as unknown as typeof fetch;

    transport = new NtfyTransport(CONFIG, FAST);
    const controller = new AbortController();
    const wait = transport.waitForAnswer('never-answered', controller.signal);

    await new Promise((r) => setTimeout(r, 10));
    expect(streamSignal?.aborted).toBe(false);
    controller.abort();

    await expect(wait).rejects.toBeInstanceOf(AbortedWaitError);
    // The abort must reach the fetch, not just detach the waiter — otherwise
    // every stop/retry cycle leaks one ntfy connection for the process's life.
    expect(streamSignal?.aborted).toBe(true);
    expect(opens).toBe(1);
  });

  it('rejects immediately when the signal is already aborted', async () => {
    globalThis.fetch = jest.fn(async () => pollResponse([])) as unknown as typeof fetch;
    transport = new NtfyTransport(CONFIG, FAST);

    await expect(transport.waitForAnswer('x', AbortSignal.abort())).rejects.toBeInstanceOf(
      AbortedWaitError
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('preserves the caller\'s AbortSignal.reason on .cause and .reason when aborted asynchronously', async () => {
    globalThis.fetch = jest.fn(async (url: unknown) => {
      if (String(url).includes('poll=1')) return pollResponse([]);
      return openStream([]);
    }) as unknown as typeof fetch;

    transport = new NtfyTransport(CONFIG, FAST);
    const controller = new AbortController();
    const wait = transport.waitForAnswer('never-answered', controller.signal);

    await new Promise((r) => setTimeout(r, 10));
    const stopReason = new Error('Stop requested by user');
    controller.abort(stopReason);

    // The caller's own reason for cancelling — not a generic re-statement of
    // "it was cancelled" — is what lets a handler upstream tell a user Stop
    // apart from a host timeout. Losing it here loses that distinction for
    // every caller of waitFor, not just this one.
    await expect(wait).rejects.toMatchObject({ cause: stopReason, reason: stopReason });
  });

  it('preserves the caller\'s AbortSignal.reason on .cause and .reason when already aborted', async () => {
    globalThis.fetch = jest.fn(async () => pollResponse([])) as unknown as typeof fetch;
    transport = new NtfyTransport(CONFIG, FAST);

    const hostTimeout = new Error('host timeout');
    const signal = AbortSignal.abort(hostTimeout);

    await expect(transport.waitForAnswer('x', signal)).rejects.toMatchObject({
      cause: hostTimeout,
      reason: hostTimeout,
    });
  });

  it('backs off on a burst 429 then succeeds', async () => {
    let attempts = 0;
    globalThis.fetch = jest.fn(async () => {
      attempts++;
      if (attempts < 3) {
        return errorResponse(429, JSON.stringify({ code: 42901, http: 429, error: 'limit reached' }));
      }
      return { ok: true, status: 200, statusText: 'OK' } as Response;
    }) as unknown as typeof fetch;

    transport = new NtfyTransport(CONFIG, FAST);
    await transport.publish({
      type: 'notification',
      messageId: 'n1',
      timestamp: 1,
      title: 't',
      body: 'b',
    });

    expect(attempts).toBe(3);
  });

  it('fails fast on the daily quota without exhausting its retries (C-13)', async () => {
    let attempts = 0;
    globalThis.fetch = jest.fn(async () => {
      attempts++;
      return errorResponse(
        429,
        JSON.stringify({ code: 42908, http: 429, error: 'limit reached: daily message quota reached' })
      );
    }) as unknown as typeof fetch;

    transport = new NtfyTransport(CONFIG, FAST);
    await expect(
      transport.publish({ type: 'notification', messageId: 'n2', timestamp: 1, title: 't', body: 'b' })
    ).rejects.toThrow(/UTC midnight/);

    expect(attempts).toBe(1);
  });

  it('gives up after the attempt cap on a persistent burst 429', async () => {
    let attempts = 0;
    globalThis.fetch = jest.fn(async () => {
      attempts++;
      return errorResponse(429, JSON.stringify({ code: 42901 }), { 'retry-after': '0' });
    }) as unknown as typeof fetch;

    transport = new NtfyTransport(CONFIG, FAST);
    await expect(
      transport.publish({ type: 'notification', messageId: 'n3', timestamp: 1, title: 't', body: 'b' })
    ).rejects.toBeInstanceOf(NtfyPublishError);

    expect(attempts).toBe(FAST.retry.maxAttempts);
  });

  it('uploads an attachment as one PUT carrying the outer message in X-Message', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = jest.fn(async (url: unknown, init: unknown) => {
      calls.push({ url: String(url), init: init as RequestInit });
      return { ok: true, status: 200, statusText: 'OK' } as Response;
    }) as unknown as typeof fetch;

    transport = new NtfyTransport(CONFIG, FAST);
    const review = planReviewMessage();
    await transport.publishPlan(review, 'CIPHERTEXT');

    expect(calls).toHaveLength(1);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(calls[0].init.method).toBe('PUT');
    expect(calls[0].init.body).toBe('CIPHERTEXT');
    expect(JSON.parse(headers['X-Message'])).toEqual(review);
    // The filename is random hex, never the plan's real path (F-9).
    expect(headers.Filename).toMatch(/^[0-9a-f]{24}\.bin$/);
    expect(headers.Filename).not.toContain('plan');
  });

  it('refuses an X-Message header over the proxy budget before the PUT (D14)', async () => {
    globalThis.fetch = jest.fn(async () => {
      throw new Error('fetch must not be reached');
    }) as unknown as typeof fetch;

    transport = new NtfyTransport(CONFIG, FAST);
    const oversizedHeader = JSON.stringify({ padding: 'x'.repeat(X_MESSAGE_MAX_BYTES) });

    await expect(transport.uploadAttachment('CIPHER', oversizedHeader)).rejects.toBeInstanceOf(
      XMessageTooLargeError
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('refuses a header containing a line break, which would split the request', async () => {
    globalThis.fetch = jest.fn() as unknown as typeof fetch;
    transport = new NtfyTransport(CONFIG, FAST);

    await expect(transport.uploadAttachment('CIPHER', '{"a":1}\r\nX-Evil: 1')).rejects.toThrow(
      /line break/
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('refuses to publish a plan message that would have to chunk (C-1)', async () => {
    globalThis.fetch = jest.fn() as unknown as typeof fetch;
    transport = new NtfyTransport(CONFIG, FAST);

    const huge = { ...planReviewMessage(), context: 'x'.repeat(4000) };
    await expect(transport.publishPlan(huge, 'CIPHER')).rejects.toThrow(/must never chunk/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('publishes an inline plan message as a single POST', async () => {
    const bodies: string[] = [];
    globalThis.fetch = jest.fn(async (_url: unknown, init: unknown) => {
      bodies.push((init as { body: string }).body);
      return { ok: true, status: 200, statusText: 'OK' } as Response;
    }) as unknown as typeof fetch;

    transport = new NtfyTransport(CONFIG, FAST);
    const review = planReviewMessage();
    await transport.publishPlan(review);

    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0])).toEqual(review);
  });

  it('reports an expired attachment distinctly from a failed one (C-4/C-12)', async () => {
    globalThis.fetch = jest.fn(async () =>
      ({ ok: false, status: 404, statusText: 'Not Found' } as Response)
    ) as unknown as typeof fetch;

    transport = new NtfyTransport(CONFIG, FAST);
    await expect(
      transport.downloadAttachment({ name: 'a.bin', url: 'https://ntfy.sh/file/a.bin' })
    ).rejects.toBeInstanceOf(AttachmentExpiredError);
  });

  it('downloads an attachment body verbatim', async () => {
    globalThis.fetch = jest.fn(async () =>
      ({ ok: true, status: 200, statusText: 'OK', text: async () => 'CIPHER' } as unknown as Response)
    ) as unknown as typeof fetch;

    transport = new NtfyTransport(CONFIG, FAST);
    expect(
      await transport.downloadAttachment({ name: 'a.bin', url: 'https://ntfy.sh/file/a.bin' })
    ).toBe('CIPHER');
  });

  it('keeps both waits alive when two register on the same key (C1)', async () => {
    globalThis.fetch = jest.fn(async (url: unknown) => {
      if (String(url).includes('poll=1')) return pollResponse([]);
      return openStream([answerEvent('shared', 'first'), answerEvent('shared', 'second')]);
    }) as unknown as typeof fetch;

    transport = new NtfyTransport(CONFIG, FAST);

    // Two calls can resolve to one key — two ReviewPlan calls on unchanged
    // content, most obviously. Keying the registry by that string let the
    // second registration displace the first, leaving a promise nobody could
    // settle; and either one's cleanup then deleted the other's live entry.
    const first = transport.waitForAnswer('shared');
    const second = transport.waitForAnswer('shared');

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it('does not let one abort cancel another wait sharing its key (C1)', async () => {
    globalThis.fetch = jest.fn(async (url: unknown) => {
      if (String(url).includes('poll=1')) return pollResponse([]);
      return openStream([]);
    }) as unknown as typeof fetch;

    transport = new NtfyTransport(CONFIG, FAST);

    const doomed = new AbortController();
    const abandoned = transport.waitForAnswer('shared', doomed.signal);
    const survivor = transport.waitForAnswer('shared');

    doomed.abort();
    await expect(abandoned).rejects.toBeInstanceOf(AbortedWaitError);

    // The survivor must still be registered: deliver a matching answer and it
    // resolves. Before the fix its entry had been deleted by the other's key.
    await new Promise((r) => setTimeout(r, 5));
    transport.close();
    await expect(survivor).rejects.toThrow(/Transport closed/);
  });

  it('gives up and reports why when ntfy refuses the subscription (H2)', async () => {
    let opens = 0;
    globalThis.fetch = jest.fn(async (url: unknown) => {
      if (String(url).includes('poll=1')) return pollResponse([]);
      opens++;
      return errorResponse(403, JSON.stringify({ code: 40301, error: 'forbidden' }));
    }) as unknown as typeof fetch;

    transport = new NtfyTransport(CONFIG, FAST);

    // A 403 from an auth-required topic or a mistyped ntfyUrl never becomes a
    // 200. Reconnecting forever at 30 s hid the one diagnosable fact there was
    // behind a call that simply never returned.
    await expect(transport.waitForAnswer('never-arrives')).rejects.toThrow(/403/);
    expect(opens).toBe(1);
  });

  it('keeps reconnecting when the subscription failure is retryable (H2)', async () => {
    let opens = 0;
    globalThis.fetch = jest.fn(async (url: unknown) => {
      if (String(url).includes('poll=1')) return pollResponse([]);
      opens++;
      return opens === 1 ? errorResponse(503, 'upstream down') : openStream([answerEvent('later')]);
    }) as unknown as typeof fetch;

    transport = new NtfyTransport(CONFIG, FAST);
    const answer = await transport.waitForAnswer('later');

    expect(answer.questionId).toBe('later');
    expect(opens).toBeGreaterThanOrEqual(2);
  });

  it('closes the stream and rejects every outstanding wait on close()', async () => {
    globalThis.fetch = jest.fn(async (url: unknown) => {
      if (String(url).includes('poll=1')) return pollResponse([]);
      return openStream([]);
    }) as unknown as typeof fetch;

    transport = new NtfyTransport(CONFIG, FAST);
    const wait = transport.waitForAnswer('pending-forever');
    await new Promise((r) => setTimeout(r, 5));
    transport.close();

    await expect(wait).rejects.toThrow(/Transport closed/);
  });

  it('gives a late second submission to the watcher, never to the winner (D-5)', async () => {
    globalThis.fetch = jest.fn(async (url: unknown) => {
      if (String(url).includes('poll=1')) return pollResponse([]);
      return openStream([
        reviewResponseEvent('review-1', 'resp-phone'),
        reviewResponseEvent('review-1', 'resp-laptop'),
      ]);
    }) as unknown as typeof fetch;

    transport = new NtfyTransport(CONFIG, FAST);
    const seen: string[] = [];
    const matches = (msg: AnyHitlMessage) =>
      msg.type === 'plan_review_response' && msg.reviewId === 'review-1';

    const stop = transport.watch('late:review-1', matches, (r) => seen.push(r.msg.messageId));
    const winner = await transport.waitFor<PlanReviewResponseMessage>(
      'plan_review_response:review-1',
      matches
    );
    await new Promise((r) => setTimeout(r, 10));
    stop();

    // The waiter consumes the first; only the loser reaches the watcher.
    expect(winner.msg.messageId).toBe('resp-phone');
    expect(seen).toEqual(['resp-laptop']);
  });

  it('lets a waiter still receive a message a watcher only observed (H3)', async () => {
    globalThis.fetch = jest.fn(async (url: unknown) => {
      if (String(url).includes('poll=1')) {
        return pollResponse([reviewResponseEvent('review-9', 'resp-1')]);
      }
      return openStream([reviewResponseEvent('review-9', 'resp-1')]);
    }) as unknown as typeof fetch;

    transport = new NtfyTransport(CONFIG, FAST);
    const observed: string[] = [];
    const matches = (msg: AnyHitlMessage) =>
      msg.type === 'plan_review_response' && msg.reviewId === 'review-9';

    const stop = transport.watch('late:review-9', matches, (r) => observed.push(r.msg.messageId));

    // The response lands while only the watcher is attached — the D-8 resume
    // shape, where the review was published before this process restarted.
    await new Promise((r) => setTimeout(r, 10));
    expect(observed).toEqual(['resp-1']);

    // Marking it seen on observation used to hide it from the replay backstop,
    // so the wait that was about to start could never be satisfied — while the
    // human had already been told their submission was lost.
    const got = await transport.waitFor<PlanReviewResponseMessage>(
      'plan_review_response:review-9',
      matches
    );
    expect(got.msg.messageId).toBe('resp-1');
    stop();
  });

  it('stops delivering and drops its subscription hold once released', async () => {
    let streamSignal: AbortSignal | undefined;
    globalThis.fetch = jest.fn(async (url: unknown, init: unknown) => {
      if (String(url).includes('poll=1')) return pollResponse([]);
      streamSignal = (init as RequestInit).signal ?? undefined;
      return openStream([]);
    }) as unknown as typeof fetch;

    transport = new NtfyTransport(CONFIG, FAST);
    const stop = transport.watch('late:review-1', () => true, () => {});

    // A watcher alone keeps the stream open — that is the point of holding it
    // past the wait.
    await new Promise((r) => setTimeout(r, 10));
    expect(streamSignal?.aborted).toBe(false);

    stop();
    stop(); // Idempotent: a double release must not unbalance the ref count.
    await new Promise((r) => setTimeout(r, 10));
    expect(streamSignal?.aborted).toBe(true);
  });
});

function reviewResponseEvent(reviewId: string, id: string, time = 1_700_000_000): string {
  const msg: PlanReviewResponseMessage = {
    type: 'plan_review_response',
    messageId: id,
    timestamp: 1_700_000_000_000,
    protocolVersion: PROTOCOL_VERSION,
    reviewId,
    respondedFrom: 'Kay9',
    verdict: 'approved',
    snapshotHash: `sha256:${'b'.repeat(64)}`,
    body: { kind: 'inline', contentHash: 'c'.repeat(64), contentLength: 12, data: 'PAYLOAD' },
  };
  return JSON.stringify({ id, time, event: 'message', message: JSON.stringify(msg) });
}

function planReviewMessage(): PlanReviewMessage {
  return {
    type: 'plan_review',
    messageId: 'review-1',
    timestamp: 1_700_000_000_000,
    protocolVersion: PROTOCOL_VERSION,
    repo: null,
    context: 'implementing the thing',
    summary: '',
    displayPath: 'docs/plan.md',
    planId: 'a'.repeat(64),
    revision: 1,
    isNewPlan: true,
    snapshotHash: `sha256:${'b'.repeat(64)}`,
    body: { kind: 'attachment', contentHash: 'c'.repeat(64), contentLength: 4096 },
  };
}
