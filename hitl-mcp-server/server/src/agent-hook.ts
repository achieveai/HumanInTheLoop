import { mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs';
import path from 'path';
import {
  claimNew, formatForAgent, pollAgentMessages, pruneClaims, sessionDir, streamAgentMessages,
} from './agent-messages.js';
import { sessionTag } from './identity.js';
import type { AgentMessage, HitlConfig } from './types.js';

/**
 * `hitl hook messages`: hand the human's Inbox messages to a running agent.
 *
 * Claude Code runs `--event wait` as a background (`asyncRewake`) Stop hook.
 * It waits for a message and exits 2, which wakes an idle session in every
 * Claude app. Tool and prompt hooks deliver mid-task in every host. Codex and
 * Copilot cannot be woken, so their Stop hook holds the agent while a message
 * waits.
 */

export type HookHost = 'claude' | 'codex' | 'copilot';

/** What the CLI writes and the exit code it uses. */
export interface HookResult {
  stdout?: string;
  stderr?: string;
  exitCode: number;
}

const NOTHING: HookResult = { exitCode: 0 };

/** The raw session id in hook input: `session_id` in Claude and Codex, `sessionId` in Copilot. */
export function hookSessionId(stdin: string): string | null {
  try {
    const input = JSON.parse(stdin) as { session_id?: unknown; sessionId?: unknown };
    const id = input.session_id ?? input.sessionId;
    return typeof id === 'string' && id.trim() !== '' ? id.trim() : null;
  } catch {
    return null;
  }
}

/** Stop events, by host name. A Stop delivery holds the agent instead of adding context. */
const STOP_EVENTS = new Set(['Stop', 'agentStop']);

/** The host's output shape for delivering `text` at `event`. */
export function deliver(host: HookHost, event: string, text: string): HookResult {
  if (STOP_EVENTS.has(event)) {
    return { stdout: JSON.stringify({ decision: 'block', reason: text }) + '\n', exitCode: 0 };
  }
  // Copilot reads a top-level additionalContext; Claude Code and Codex read hookSpecificOutput.
  const body = host === 'copilot'
    ? { additionalContext: text }
    : { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
  return { stdout: JSON.stringify(body) + '\n', exitCode: 0 };
}

/** Tool hooks fire on every call; ask ntfy at most this often per session. */
export const POLL_INTERVAL_MS = 10_000;

/** True when this session last polled under `POLL_INTERVAL_MS` ago; otherwise records a poll now. */
export function recentlyPolled(tag: string, event: string, now = Date.now()): boolean {
  if (STOP_EVENTS.has(event) || event === 'UserPromptSubmit' || event === 'userPromptSubmitted') return false;
  const file = path.join(sessionDir(tag), 'last-poll');
  try {
    if (now - statSync(file).mtimeMs < POLL_INTERVAL_MS) return true;
  } catch {
    // First poll for this session.
  }
  mkdirSync(sessionDir(tag), { recursive: true });
  writeFileSync(file, '');
  const at = new Date(now);
  utimesSync(file, at, at);
  return false;
}

export interface HookDeps {
  poll: (config: HitlConfig, tag: string) => Promise<AgentMessage[]>;
}

const defaultDeps: HookDeps = { poll: pollAgentMessages };

/**
 * One delivery pass for a tool, prompt or Stop hook. Anything unexpected
 * delivers nothing: the worst case is the behaviour without this hook.
 */
export async function runMessagesHook(
  stdin: string,
  host: HookHost,
  event: string,
  config: HitlConfig,
  deps: HookDeps = defaultDeps,
): Promise<HookResult> {
  const id = hookSessionId(stdin);
  if (!id || !config.encryptionKey) return NOTHING;
  const tag = sessionTag(id);
  if (recentlyPolled(tag, event)) return NOTHING;
  let fresh: AgentMessage[];
  try {
    fresh = claimNew(tag, await deps.poll(config, tag));
  } catch (err) {
    console.error(`hitl: could not check for messages: ${(err as Error).message}`);
    return NOTHING;
  }
  pruneClaims(tag);
  return fresh.length ? deliver(host, event, formatForAgent(fresh)) : NOTHING;
}

// ---------------------------------------------------------------------------
// The background waiter (Claude Code, `asyncRewake` Stop hook)
// ---------------------------------------------------------------------------

/** A waiter gives up after ntfy's own retention: anything older is gone anyway. */
export const WAITER_LIFETIME_MS = 12 * 60 * 60 * 1000;
const OWNERSHIP_CHECK_MS = 5_000;
const RECONNECT_MS = 5_000;

const pidFile = (tag: string) => path.join(sessionDir(tag), 'waiter.pid');

/** Make this process the session's only waiter. An older waiter sees the change and exits. */
export function takeWaiterSlot(tag: string, pid = process.pid): void {
  mkdirSync(sessionDir(tag), { recursive: true });
  writeFileSync(pidFile(tag), String(pid));
}

export function ownsWaiterSlot(tag: string, pid = process.pid): boolean {
  try {
    return readFileSync(pidFile(tag), 'utf8').trim() === String(pid);
  } catch {
    return false;
  }
}

/** Release the slot (SessionEnd), so a waiter left behind stops at its next check. */
export function releaseWaiterSlot(tag: string): void {
  rmSync(pidFile(tag), { force: true });
}

export interface WaitDeps extends HookDeps {
  stream: typeof streamAgentMessages;
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  parentAlive: () => boolean;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

function parentAlive(): boolean {
  try {
    process.kill(process.ppid, 0);
    return true;
  } catch {
    return false;
  }
}

const defaultWaitDeps: WaitDeps = {
  poll: pollAgentMessages, stream: streamAgentMessages, now: Date.now, sleep: abortableSleep, parentAlive,
};

/**
 * Wait for this session's next message. Exit 2 with the message on stderr
 * wakes Claude; exit 0 means this waiter stood down (replaced, session gone,
 * lifetime over) and wakes nothing.
 *
 * The slot is checked before every claim, so a replaced or orphaned waiter
 * never takes a message it can no longer deliver.
 */
export async function waitForMessages(
  stdin: string,
  config: HitlConfig,
  deps: WaitDeps = defaultWaitDeps,
): Promise<HookResult> {
  const id = hookSessionId(stdin);
  if (!id || !config.encryptionKey) return NOTHING;
  const tag = sessionTag(id);
  takeWaiterSlot(tag);
  pruneClaims(tag);

  const started = deps.now();
  const stop = new AbortController();
  const stillWanted = () => ownsWaiterSlot(tag) && deps.parentAlive() && deps.now() - started < WAITER_LIFETIME_MS;
  let found: AgentMessage[] = [];
  const take = (messages: AgentMessage[]) => {
    if (found.length || !stillWanted()) return;
    found = claimNew(tag, messages);
    if (found.length) stop.abort();
  };

  const watchdog = setInterval(() => { if (!stillWanted()) stop.abort(); }, OWNERSHIP_CHECK_MS);
  try {
    // Messages sent while no waiter ran are in the cache; the stream covers what comes next.
    const sinceSeconds = Math.floor(deps.now() / 1000);
    try {
      take(await deps.poll(config, tag));
    } catch (err) {
      console.error(`hitl: could not check for messages: ${(err as Error).message}`);
    }
    let since = sinceSeconds;
    while (!stop.signal.aborted && stillWanted()) {
      try {
        await deps.stream(config, tag, since, msg => take([msg]), stop.signal);
      } catch (err) {
        console.error(`hitl: message stream dropped: ${(err as Error).message}`);
      }
      if (stop.signal.aborted) break;
      // Reconnect a little back in time; claims make a replayed message harmless.
      since = Math.floor(deps.now() / 1000) - 60;
      await deps.sleep(RECONNECT_MS, stop.signal);
    }
  } finally {
    clearInterval(watchdog);
  }
  if (!found.length) return NOTHING;
  return { stderr: formatForAgent(found), exitCode: 2 };
}
