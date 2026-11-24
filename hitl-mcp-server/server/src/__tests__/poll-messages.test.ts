import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { HumanInTheLoopServer } from '../mcp-server.js';
import { sealAgentMessage } from '../agent-messages.js';
import { sessionTag } from '../identity.js';
import type { AgentMessage, HitlConfig } from '../types.js';

const KEY = 'a'.repeat(64);
const THREAD = '018f2d6a-1111-7111-8111-111111111111';
const CONFIG: HitlConfig = {
  topicId: 'topic-under-test',
  ntfyUrl: 'https://ntfy.invalid',
  deviceName: 'test-device',
  soundEnabled: false,
  encryptionKey: KEY,
};

function toolHandlers(server: HumanInTheLoopServer) {
  return (server as unknown as {
    server: { _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<unknown>> };
  }).server._requestHandlers;
}

function textResult(result: unknown) {
  const blocks = (result as { content: Array<{ text: string }> }).content;
  return JSON.parse(blocks[0].text) as {
    success: boolean;
    messages: Array<{ messageId: string; text: string; from: string; timestamp: number }>;
  };
}

describe('PollMessages', () => {
  const realFetch = globalThis.fetch;
  const originalHome = process.env.HITL_HOME;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'hitl-poll-messages-'));
    process.env.HITL_HOME = home;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (originalHome === undefined) delete process.env.HITL_HOME;
    else process.env.HITL_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('is advertised without arguments and returns addressed messages once', async () => {
    const message: AgentMessage = {
      type: 'agent_message',
      messageId: 'message-1',
      timestamp: 1_700_000_000_000,
      to: sessionTag(THREAD),
      text: 'Check the result',
      from: 'Inbox',
    };
    const other = { ...message, messageId: 'other-session', to: sessionTag('other-thread') };
    const body = [message, other]
      .map(msg => JSON.stringify({ event: 'message', message: sealAgentMessage(msg, KEY) }))
      .join('\n');
    globalThis.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => body,
    })) as unknown as typeof fetch;

    const server = new HumanInTheLoopServer(CONFIG);
    try {
      const handlers = toolHandlers(server);
      const listed = await handlers.get('tools/list')?.({ method: 'tools/list', params: {} }, {}) as {
        tools: Array<{ name: string; inputSchema: { required?: string[] } }>;
      };
      const tool = listed.tools.find(item => item.name === 'PollMessages');
      expect(tool).toBeDefined();
      expect(tool?.inputSchema.required).toBeUndefined();

      const callTool = handlers.get('tools/call')!;
      const request = {
        method: 'tools/call',
        params: { name: 'PollMessages', arguments: {} },
      };
      const extra = { _meta: { threadId: THREAD } };
      const first = textResult(await callTool(request, extra));
      expect(first.success).toBe(true);
      expect(first.messages).toEqual([{
        messageId: message.messageId,
        text: message.text,
        from: message.from,
        timestamp: message.timestamp,
      }]);

      const second = textResult(await callTool(request, extra));
      expect(second.messages).toEqual([]);
    } finally {
      (server as unknown as { transport: { close: () => void } }).transport.close();
    }
  });

  it('fails clearly when encrypted agent messages have no key', async () => {
    const server = new HumanInTheLoopServer({ ...CONFIG, encryptionKey: undefined });
    try {
      const callTool = toolHandlers(server).get('tools/call')!;
      await expect(callTool({
        method: 'tools/call',
        params: { name: 'PollMessages', arguments: {} },
      }, { _meta: { threadId: THREAD } })).rejects.toThrow(/always encrypted.*encryptionKey/);
    } finally {
      (server as unknown as { transport: { close: () => void } }).transport.close();
    }
  });

  it('uses the process session fallback when the host supplies no identity', async () => {
    globalThis.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '',
    })) as unknown as typeof fetch;
    const server = new HumanInTheLoopServer(CONFIG);
    try {
      const callTool = toolHandlers(server).get('tools/call')!;
      const result = textResult(await callTool({
        method: 'tools/call',
        params: { name: 'PollMessages', arguments: {} },
      }, {}));
      expect(result).toEqual({ success: true, messages: [] });
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    } finally {
      (server as unknown as { transport: { close: () => void } }).transport.close();
    }
  });
});
