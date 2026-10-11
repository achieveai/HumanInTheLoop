import { randomUUID } from 'crypto';
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import { CHUNK_THRESHOLD_BYTES } from './chunking.js';
import { hitlDir } from './config.js';
import { decrypt, encrypt } from './crypto.js';
import { NtfyTransport, NtfySubscribeError, classifyNtfyError } from './ntfy-transport.js';
import type { AgentMessage, HitlConfig } from './types.js';

/**
 * Messages from the human to one running agent session.
 *
 * Inbox (or `hitl send`) publishes an `agent_message` to `<topic>-agents`,
 * addressed by session tag. Whatever reaches the agent first — a host hook or
 * the MCP server's channel push — claims the message with a marker file, so it
 * is delivered once. Only messages sealed with the HITL key are read: a message
 * steers an agent, so plaintext from anyone who knows the topic is ignored.
 */

/** Their own topic, so idle hooks never download question or plan traffic. */
export const agentsTopic = (config: HitlConfig) => `${config.topicId}-agents`;

const TAG_PATTERN = /^[0-9a-f]{12}$/;

export function isSessionTag(value: string): boolean {
  return TAG_PATTERN.test(value);
}

/** The sealed message must fit one ntfy message; agent messages never chunk. */
export function sealAgentMessage(msg: AgentMessage, key: string): string {
  const sealed = encrypt(JSON.stringify(msg), key);
  if (Buffer.byteLength(sealed, 'utf8') > CHUNK_THRESHOLD_BYTES) {
    throw new Error('The message is too long for one ntfy message. Keep it under about 2,000 characters.');
  }
  return sealed;
}

/** The agent message in one ntfy event line, or null when it is anything else. */
export function openAgentMessage(line: string, key: string): AgentMessage | null {
  let raw: { event?: unknown; message?: unknown };
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (raw.event !== 'message' || typeof raw.message !== 'string') return null;
  let msg: Partial<AgentMessage>;
  try {
    msg = JSON.parse(decrypt(raw.message, key)) as Partial<AgentMessage>;
  } catch {
    return null;
  }
  if (msg?.type !== 'agent_message' || typeof msg.messageId !== 'string' || typeof msg.to !== 'string'
    || typeof msg.text !== 'string') return null;
  return msg as AgentMessage;
}

function requireKey(config: HitlConfig): string {
  if (!config.encryptionKey) {
    throw new Error('Messages to agents are always encrypted: add an encryptionKey to the HITL config first.');
  }
  return config.encryptionKey;
}

/** Publish one message to a session. Returns what was sent. */
export async function sendAgentMessage(config: HitlConfig, to: string, text: string): Promise<AgentMessage> {
  const key = requireKey(config);
  if (!isSessionTag(to)) throw new Error(`"${to}" is not a session tag (12 hex characters).`);
  if (!text.trim()) throw new Error('The message is empty.');
  const msg: AgentMessage = {
    type: 'agent_message',
    messageId: randomUUID(),
    timestamp: Date.now(),
    to,
    text,
    from: config.deviceName,
  };
  const sealed = sealAgentMessage(msg, key);
  await new NtfyTransport({ ...config, topicId: agentsTopic(config) }).publishRaw(sealed);
  return msg;
}

const topicUrl = (config: HitlConfig) => `${config.ntfyUrl.replace(/\/+$/, '')}/${agentsTopic(config)}`;

/** Every message for `tag` in ntfy's cache (12 h), oldest first. Claimed ones included. */
export async function pollAgentMessages(config: HitlConfig, tag: string): Promise<AgentMessage[]> {
  const key = requireKey(config);
  const response = await fetch(`${topicUrl(config)}/json?poll=1&since=all`, { headers: { Accept: 'application/x-ndjson' } });
  if (!response.ok) {
    const verdict = classifyNtfyError(response.status, await response.text().catch(() => ''));
    throw new NtfySubscribeError(`agent message poll failed: ${verdict.message}`, response.status, verdict.retryable, verdict.code);
  }
  const found: AgentMessage[] = [];
  for (const line of (await response.text()).split('\n')) {
    const msg = openAgentMessage(line, key);
    if (msg?.to === tag) found.push(msg);
  }
  return found;
}

/**
 * Stream messages for `tag` published from `sinceSeconds` on, until `signal`
 * aborts or the server closes the stream.
 */
export async function streamAgentMessages(
  config: HitlConfig,
  tag: string,
  sinceSeconds: number,
  onMessage: (msg: AgentMessage) => void,
  signal: AbortSignal,
): Promise<void> {
  const key = requireKey(config);
  const response = await fetch(`${topicUrl(config)}/json?since=${Math.max(1, sinceSeconds)}`, {
    headers: { Accept: 'application/x-ndjson' },
    signal,
  });
  if (!response.ok) {
    const verdict = classifyNtfyError(response.status, await response.text().catch(() => ''));
    throw new NtfySubscribeError(`agent message stream failed: ${verdict.message}`, response.status, verdict.retryable, verdict.code);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body from ntfy');
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const msg = openAgentMessage(line, key);
        if (msg?.to === tag) onMessage(msg);
      }
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') return;
    throw err;
  }
}

/** This session's local state: claim markers and the waiter's pid file. */
export function sessionDir(tag: string): string {
  return path.join(hitlDir(), 'agent-inbox', tag);
}

/** ntfy forgets messages after 12 h, so a marker older than a day guards nothing. */
const MARKER_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Claim one message for delivery. True for exactly one caller per message on
 * this machine, however many hooks or servers race for it.
 */
export function claimMessage(tag: string, messageId: string): boolean {
  const dir = sessionDir(tag);
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(path.join(dir, `${safeName(messageId)}.claimed`), '', { flag: 'wx' });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

/** Unclaimed messages, each claimed by this call. */
export function claimNew(tag: string, messages: AgentMessage[]): AgentMessage[] {
  return messages.filter(msg => claimMessage(tag, msg.messageId));
}

/** Drop claim markers older than their use. Never throws. */
export function pruneClaims(tag: string, now = Date.now()): void {
  try {
    const dir = sessionDir(tag);
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.claimed')) continue;
      const file = path.join(dir, name);
      if (now - statSync(file).mtimeMs > MARKER_TTL_MS) rmSync(file, { force: true });
    }
  } catch {
    // Pruning is housekeeping only.
  }
}

/** Message ids come off the wire: keep them to safe file-name characters. */
function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100);
}

/** Prefix on everything we put in front of the agent, so it can tell these apart. */
export const MESSAGE_MARKER = '[hitl-message]';

/** What the agent reads for one or more delivered messages. */
export function formatForAgent(messages: AgentMessage[]): string {
  const parts = messages.map(msg =>
    `${MESSAGE_MARKER} The human sent you a message from HITL Inbox`
    + (msg.from ? ` (from ${msg.from})` : '') + `, id ${msg.messageId}:\n\n${msg.text}`);
  return parts.join('\n\n---\n\n')
    + '\n\nTreat it as the human\'s request. On its own it does not approve risky or irreversible actions. '
    + 'When you have handled it, reply with the HITL Notify tool and set inReplyTo to the message id.';
}
