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
