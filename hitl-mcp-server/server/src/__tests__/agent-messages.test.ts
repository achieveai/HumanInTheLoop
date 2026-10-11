import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { claimMessage, formatForAgent, openAgentMessage, sealAgentMessage } from '../agent-messages.js';
import { deliver, runMessagesHook, takeWaiterSlot, waitForMessages, type WaitDeps } from '../agent-hook.js';
import { encrypt } from '../crypto.js';
import { resolveSenderIdentity, sessionTag } from '../identity.js';
import type { AgentMessage, HitlConfig } from '../types.js';

const KEY = 'a'.repeat(64);
const config: HitlConfig = { topicId: 't', ntfyUrl: 'https://ntfy.invalid', deviceName: 'Kay9', soundEnabled: false, encryptionKey: KEY };
const SESSION = 'session-1';
const TAG = sessionTag(SESSION);
const stdin = JSON.stringify({ session_id: SESSION });

let nextId = 0;
const message = (text = 'hello', to = TAG): AgentMessage =>
  ({ type: 'agent_message', messageId: `m-${nextId++}`, timestamp: 1, to, text, from: 'Kay9' });
const line = (sealed: string) => JSON.stringify({ event: 'message', message: sealed });

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'hitl-agent-'));
  process.env.HITL_HOME = home;
});
afterEach(() => {
  delete process.env.HITL_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe('session tag', () => {
  it('is 12 hex characters, stable per id, different across ids', () => {
    expect(TAG).toMatch(/^[0-9a-f]{12}$/);
    expect(sessionTag(SESSION)).toBe(TAG);
    expect(sessionTag('session-2')).not.toBe(TAG);
  });

  it('rides on session identities, so Inbox can address the session', () => {
    expect(resolveSenderIdentity('/x/y', 'Kay9', () => SESSION).sessionTag).toBe(TAG);
  });
});

describe('wire', () => {
  it('opens only agent messages sealed with our key', () => {
    const msg = message();
    expect(openAgentMessage(line(sealAgentMessage(msg, KEY)), KEY)).toEqual(msg);
    expect(openAgentMessage(line(sealAgentMessage(msg, 'b'.repeat(64))), KEY)).toBeNull();
    expect(openAgentMessage(line(JSON.stringify(msg)), KEY)).toBeNull();
    expect(openAgentMessage(line(encrypt(JSON.stringify({ ...msg, type: 'notification' }), KEY)), KEY)).toBeNull();
    expect(openAgentMessage(JSON.stringify({ event: 'keepalive' }), KEY)).toBeNull();
  });

  it('refuses a message too long for one ntfy message', () => {
    expect(() => sealAgentMessage(message('x'.repeat(3000)), KEY)).toThrow(/too long/);
  });

  it('claims each message once', () => {
    expect(claimMessage(TAG, 'm-a')).toBe(true);
    expect(claimMessage(TAG, 'm-a')).toBe(false);
    expect(claimMessage(TAG, 'm-b')).toBe(true);
  });

  it('tells the agent the id to reply to', () => {
    const msg = message('do X');
    expect(formatForAgent([msg])).toContain(`id ${msg.messageId}`);
    expect(formatForAgent([msg])).toContain('inReplyTo');
  });
});

describe('delivery shapes', () => {
  it('adds context in Claude, Codex and Copilot tool hooks', () => {
    expect(JSON.parse(deliver('claude', 'PostToolUse', 'x').stdout!))
      .toEqual({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'x' } });
    expect(JSON.parse(deliver('copilot', 'postToolUse', 'x').stdout!)).toEqual({ additionalContext: 'x' });
  });

  it('holds the agent at a Stop', () => {
    expect(JSON.parse(deliver('codex', 'Stop', 'x').stdout!)).toEqual({ decision: 'block', reason: 'x' });
    expect(JSON.parse(deliver('copilot', 'agentStop', 'x').stdout!)).toEqual({ decision: 'block', reason: 'x' });
  });
});

describe('runMessagesHook', () => {
  it('delivers a waiting message once', async () => {
    const msg = message('please check the build');
    const poll = async () => [msg];
    const first = await runMessagesHook(stdin, 'claude', 'UserPromptSubmit', config, { poll });
    expect(first.stdout).toContain('please check the build');
    expect(await runMessagesHook(stdin, 'claude', 'UserPromptSubmit', config, { poll })).toEqual({ exitCode: 0 });
  });

  it('asks ntfy at most once per interval from tool hooks', async () => {
    let polls = 0;
    const poll = async () => { polls++; return []; };
    await runMessagesHook(stdin, 'claude', 'PostToolUse', config, { poll });
    await runMessagesHook(stdin, 'claude', 'PostToolUse', config, { poll });
    expect(polls).toBe(1);
  });

  it('does nothing without a session id or a key, and survives a failed poll', async () => {
    const poll = async () => { throw new Error('offline'); };
    expect(await runMessagesHook('{}', 'claude', 'Stop', config, { poll })).toEqual({ exitCode: 0 });
    expect(await runMessagesHook(stdin, 'claude', 'Stop', { ...config, encryptionKey: undefined }, { poll })).toEqual({ exitCode: 0 });
    expect(await runMessagesHook(stdin, 'claude', 'Stop', config, { poll })).toEqual({ exitCode: 0 });
  });
});

describe('waitForMessages', () => {
  const deps = (over: Partial<WaitDeps>): WaitDeps => ({
    poll: async () => [],
    stream: async (_c, _t, _s, _on, signal) => { await new Promise(r => signal.addEventListener('abort', r)); },
    now: Date.now,
    sleep: async () => {},
    parentAlive: () => true,
    ...over,
  });

  it('wakes the agent (exit 2) with a message sent while it waits', async () => {
    const msg = message('wake up');
    const result = await waitForMessages(stdin, config, deps({
      stream: async (_c, _t, _s, onMessage) => { onMessage(msg); },
    }));
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('wake up');
  });

  it('delivers a message sent before it started', async () => {
    const result = await waitForMessages(stdin, config, deps({ poll: async () => [message('sent earlier')] }));
    expect(result.stderr).toContain('sent earlier');
  });

  it('stands down without claiming when a newer waiter takes over', async () => {
    const msg = message('for the new waiter');
    const result = await waitForMessages(stdin, config, deps({
      stream: async (_c, _t, _s, onMessage) => { takeWaiterSlot(TAG, process.pid + 1); onMessage(msg); },
    }));
    expect(result).toEqual({ exitCode: 0 });
    expect(claimMessage(TAG, msg.messageId)).toBe(true);
  });

  it('stands down when its session is gone', async () => {
    const result = await waitForMessages(stdin, config, deps({
      parentAlive: () => false,
      poll: async () => [message('nobody to read this')],
    }));
    expect(result).toEqual({ exitCode: 0 });
  });
});
