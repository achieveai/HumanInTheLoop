import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { randomBytes } from 'crypto';
import { HumanInTheLoopServer } from '../mcp-server.js';
import { resolvePlanIdentity, readLatest } from '../snapshot-store.js';
import type { HitlConfig } from '../types.js';

/**
 * Orderings inside `handleReviewPlan` that are correct today and would break
 * silently if a later edit moved them. Nothing else in this file is coverage
 * for the handler — these are pins, not a suite.
 */

const CONFIG: HitlConfig = {
  topicId: 'topic-under-test',
  ntfyUrl: 'https://ntfy.sh',
  deviceName: 'test-device',
  soundEnabled: false,
  encryptionKey: randomBytes(32).toString('hex'),
};

/** Matches HEARTBEAT_INTERVAL_MS in mcp-server.ts. */
const HEARTBEAT_INTERVAL_MS = 15_000;

/** A response body that parks forever, so the subscription never ends on its own. */
function parkedStream() {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    body: {
      getReader: () => ({
        read: async () => await new Promise<{ done: boolean; value?: Uint8Array }>(() => {}),
        cancel: async () => {},
      }),
    },
  } as unknown as Response;
}

/** The SDK request context, with a progress token so the heartbeat actually starts. */
function extraWithProgress() {
  return {
    _meta: { progressToken: 'tok-1' },
    sendNotification: async () => {},
    signal: new AbortController().signal,
  };
}

describe('handleReviewPlan orderings', () => {
  const realFetch = globalThis.fetch;
  const originalHome = process.env.HITL_HOME;
  let home: string;
  let planPath: string;
  let server: HumanInTheLoopServer;
  let transport: {
    watch: (...args: unknown[]) => () => void;
    publishPlan: (...args: unknown[]) => Promise<void>;
    pending: { readAll: () => Array<{ id: string }> };
    close: () => void;
  };
  let calls: string[];

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'hitl-mcp-server-test-'));
    process.env.HITL_HOME = home;
    planPath = path.join(home, 'plan.md');
    writeFileSync(planPath, '# Plan\n\n- step one\n- step two\n', 'utf8');

    // Never leave the process: the only fetch here is the subscription `watch`
    // opens, and it parks until the transport is closed.
    globalThis.fetch = jest.fn(async () => parkedStream()) as unknown as typeof fetch;

    server = new HumanInTheLoopServer(CONFIG);
    transport = (server as unknown as { transport: typeof transport }).transport;

    // Not the subject of these tests, and there is no client binary here.
    (server as unknown as { requireClient: () => void }).requireClient = () => {};

    // Record the order of the two calls whose sequence is the invariant, and
    // fail the publish so both tests exercise the error path — that is where a
    // cleanup that escaped its `finally` shows up.
    calls = [];
    const realWatch = transport.watch.bind(transport);
    transport.watch = (...args: unknown[]) => {
      calls.push('watch');
      return realWatch(...args);
    };
    transport.publishPlan = async () => {
      calls.push('publishPlan');
      throw new Error('ntfy unreachable');
    };
  });

  afterEach(() => {
    transport.close();
    globalThis.fetch = realFetch;
    if (originalHome === undefined) delete process.env.HITL_HOME;
    else process.env.HITL_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('registers the late-response watcher before publishing the review (D-5)', async () => {
    const review = (
      server as unknown as {
        handleReviewPlan: (a: Record<string, unknown>, e: unknown) => Promise<unknown>;
      }
    ).handleReviewPlan({ filePath: planPath, context: 'pinning the ordering' }, extraWithProgress());

    await expect(review).rejects.toThrow(/ntfy unreachable/);

    // Publishing first would leave a window in which a second device's response
    // arrives with nobody watching — the silent drop `watch()` exists to stop.
    expect(calls).toEqual(['watch', 'publishPlan']);
  });

  it('clears the heartbeat and the pending entry together when the review fails (D-9)', async () => {
    const setSpy = jest.spyOn(globalThis, 'setInterval');
    const clearSpy = jest.spyOn(globalThis, 'clearInterval');

    const review = (
      server as unknown as {
        handleReviewPlan: (a: Record<string, unknown>, e: unknown) => Promise<unknown>;
      }
    ).handleReviewPlan({ filePath: planPath, context: 'pinning the ordering' }, extraWithProgress());

    await expect(review).rejects.toThrow(/ntfy unreachable/);

    const heartbeats = setSpy.mock.results
      .filter((_, i) => setSpy.mock.calls[i]?.[1] === HEARTBEAT_INTERVAL_MS)
      .map((r) => r.value);
    expect(heartbeats).toHaveLength(1);

    // Both of these live in one `finally`. Split them, or make either
    // conditional, and a cancelled or failed call leaks an interval that fires
    // for the life of the process.
    expect(clearSpy).toHaveBeenCalledWith(heartbeats[0]);
    expect(transport.pending.readAll()).toEqual([]);
  });

  it('advances the stored revision only once the review is published (M6)', async () => {
    const identity = resolvePlanIdentity(realpathSync.native(planPath));
    const review = (a: Record<string, unknown>, e: unknown) =>
      (
        server as unknown as {
          handleReviewPlan: (a: Record<string, unknown>, e: unknown) => Promise<unknown>;
        }
      ).handleReviewPlan(a, e);

    await expect(
      review({ filePath: planPath, context: 'publish fails' }, extraWithProgress())
    ).rejects.toThrow(/ntfy unreachable/);

    // `latest.json` is the baseline the next review diffs against. Flipping it
    // for a revision that never left the process rebases the next diff onto
    // content nobody saw, so the change the human was asked about disappears.
    expect(readLatest(identity)).toBeNull();

    // Now the publish lands and the wait is cancelled straight afterwards: the
    // revision reached ntfy, so it becomes the baseline — and it is still
    // revision 1, because the failure above did not consume the number.
    transport.publishPlan = async () => {};
    await expect(
      review(
        { filePath: planPath, context: 'publish succeeds' },
        { ...extraWithProgress(), signal: AbortSignal.abort() }
      )
    ).rejects.toThrow();

    expect(readLatest(identity)?.revision).toBe(1);
  });
});

/**
 * A wait cancelled by the caller's AbortSignal (Stop, or a host-side timeout)
 * is a real, recoverable event — not the same as ntfy being unreachable. The
 * message an agent sees for it must say plainly that the wait was cancelled
 * before a response arrived and name the two things that actually cancel it,
 * without asserting that Claude Code's auto-background feature is the cause:
 * it only ever *disconnects* a call already running in the background, it does
 * not itself abort the request (see CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS).
 */
describe('abort remediation (honest wait-cancelled wording)', () => {
  const realFetch = globalThis.fetch;
  const originalHome = process.env.HITL_HOME;
  let home: string;
  let planPath: string;
  let server: HumanInTheLoopServer;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'hitl-abort-remediation-'));
    process.env.HITL_HOME = home;
    planPath = path.join(home, 'plan.md');
    writeFileSync(planPath, '# Plan\n\n- step one\n', 'utf8');

    // Three request shapes share this mock: the cache poll (`poll=1`), the SSE
    // subscribe `watch()` opens (`/json` with no poll), which must park rather
    // than resolve, and a plain publish POST, which just needs to succeed.
    globalThis.fetch = jest.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes('poll=1')) {
        return { ok: true, status: 200, statusText: 'OK', text: async () => '' } as unknown as Response;
      }
      if (u.includes('/json')) {
        return parkedStream();
      }
      return { ok: true, status: 200, statusText: 'OK' } as unknown as Response;
    }) as unknown as typeof fetch;

    server = new HumanInTheLoopServer(CONFIG);
    // Not the subject of these tests, and there is no client binary here.
    (server as unknown as { requireClient: () => void }).requireClient = () => {};
  });

  afterEach(() => {
    (server as unknown as { transport: { close: () => void } }).transport.close();
    globalThis.fetch = realFetch;
    if (originalHome === undefined) delete process.env.HITL_HOME;
    else process.env.HITL_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  /**
   * The wording both tools must produce for a genuine abort: say the wait was
   * cancelled before a response, name Stop and a host timeout as the two real
   * causes, and offer the auto-background setting as something to try — never
   * as a stated cause, because it is not one.
   */
  function assertHonestAbortWording(message: string): void {
    expect(message).toMatch(/wait cancelled before response/i);
    expect(message).toMatch(/stop or host timeout/i);
    expect(message).toContain('CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0');
    expect(message).toMatch(/global settings/i);
    expect(message).toMatch(/restart/i);
    expect(message).not.toMatch(/auto-background[^.]*(trigger|caus|initiat)/i);
  }

  it('gives honest remediation when AskUserQuestion is aborted mid-wait', async () => {
    // The tool handler is registered on the SDK Server rather than exposed as a
    // method (see wire-compat.test.ts), so this reaches for it directly.
    const handlers = (
      server as unknown as { server: { _requestHandlers: Map<string, unknown> } }
    ).server._requestHandlers;
    const callTool = handlers.get('tools/call') as (
      req: unknown,
      extra: unknown
    ) => Promise<unknown>;

    let caught: unknown;
    try {
      await callTool(
        {
          method: 'tools/call',
          params: {
            name: 'AskUserQuestion',
            arguments: {
              context: 'ctx',
              question: 'Proceed?',
              options: [{ label: 'Yes', value: 'yes' }],
            },
          },
        },
        { signal: AbortSignal.abort() }
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    assertHonestAbortWording((caught as Error).message);
  });

  it('gives honest remediation when ReviewPlan is aborted mid-wait', async () => {
    const transport = (
      server as unknown as { transport: { publishPlan: (...args: unknown[]) => Promise<void> } }
    ).transport;
    // The publish itself must succeed so the abort is reached in the wait,
    // not mistaken for a publish failure by getting short-circuited first.
    transport.publishPlan = async () => {};

    let caught: unknown;
    try {
      await (
        server as unknown as {
          handleReviewPlan: (a: Record<string, unknown>, e: unknown) => Promise<unknown>;
        }
      ).handleReviewPlan(
        { filePath: planPath, context: 'abort remediation test' },
        { ...extraWithProgress(), signal: AbortSignal.abort() }
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    assertHonestAbortWording((caught as Error).message);
  });
});

/**
 * `sender` on `PlanReviewMessage` is resolved from the plan's own directory
 * (`path.dirname(plan.resolvedPath)`), not `process.cwd()`, matching the
 * existing `repo` field a few lines above it in `handleReviewPlan` — and it
 * must be entirely absent from the published JSON, not `null`, when the
 * operator has opted out via `identityEnabled: false`.
 */
describe('handleReviewPlan sender identity', () => {
  const realFetch = globalThis.fetch;
  const originalHome = process.env.HITL_HOME;
  let home: string;
  let planPath: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'hitl-mcp-server-sender-'));
    process.env.HITL_HOME = home;
    planPath = path.join(home, 'plan.md');
    writeFileSync(planPath, '# Plan\n\n- step one\n', 'utf8');

    // Only the plan-review flow up to (not including) the wait is under test;
    // parking the subscription keeps `watch()` from ever resolving on its own.
    globalThis.fetch = jest.fn(async () => parkedStream()) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (originalHome === undefined) delete process.env.HITL_HOME;
    else process.env.HITL_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  /**
   * Build a server, capture what it hands `transport.publishPlan`, then let
   * the wait fail fast. Round-tripped through JSON, same as the real wire
   * path (`ntfy-transport.ts` calls `JSON.stringify` on this exact object) —
   * an `undefined`-valued `sender` must vanish here exactly as it does there,
   * not merely read as `undefined` on the in-memory object.
   */
  async function capturePublishedReview(config: HitlConfig): Promise<unknown> {
    const server = new HumanInTheLoopServer(config);
    (server as unknown as { requireClient: () => void }).requireClient = () => {};
    const transport = (
      server as unknown as { transport: { publishPlan: (...args: unknown[]) => Promise<void>; close: () => void } }
    ).transport;

    let published: unknown;
    transport.publishPlan = async (msg: unknown) => {
      published = JSON.parse(JSON.stringify(msg));
      throw new Error('stop before waiting for a response');
    };

    try {
      await expect(
        (
          server as unknown as {
            handleReviewPlan: (a: Record<string, unknown>, e: unknown) => Promise<unknown>;
          }
        ).handleReviewPlan({ filePath: planPath, context: 'checking sender identity' }, extraWithProgress())
      ).rejects.toThrow();
    } finally {
      transport.close();
    }

    return published;
  }

  it('attaches a sender identity resolved from the plan directory when identity is enabled', async () => {
    const published = (await capturePublishedReview(CONFIG)) as { sender?: { label: string; source: string } };

    expect(published.sender).toBeDefined();
    // defaultSessionNameResolver now always mints an id (Task 4), so this
    // resolves at the session tier and the label is composed per spec §5.4
    // (repo · branch · id-prefix) rather than carrying CONFIG.deviceName —
    // deviceName only appears in the worktree/path tiers' labels.
    expect(published.sender?.source).toBe('session');
    // Four id characters, whatever alphabet they come from. The old
    // `[0-9a-f-]{4}` assumed a minted UUID and went red inside any Claude Code
    // Remote Control session, where the resolver prefers the bridge id instead
    // — an ambient-environment dependency, not a real regression. The suffix's
    // *content* is pinned in identity.test.ts against controlled inputs.
    expect(published.sender?.label).toMatch(/ · [0-9A-Za-z-]{4}$/);
  });

  it('omits sender entirely from the published JSON when identityEnabled is false', async () => {
    const published = await capturePublishedReview({ ...CONFIG, identityEnabled: false });

    expect(published).not.toHaveProperty('sender');
  });
});
