import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { HitlConfig } from '../types.js';

const mockEnsureClientRunning = jest.fn(() => ({ ok: false, reason: 'no local client' }));
const mockPerformSetup = jest.fn(async (_serverDir: string, options?: { autoLaunchClient?: boolean }) => ({
  success: options?.autoLaunchClient === false,
  steps: [{
    step: 'client',
    status: options?.autoLaunchClient === false ? 'skipped' : 'not_found',
    message: 'setup result',
  }],
  summary: 'setup result',
}));

jest.unstable_mockModule('../setup.js', () => ({
  ensureClientRunning: mockEnsureClientRunning,
  performSetup: mockPerformSetup,
}));

const { HumanInTheLoopServer, parseServerOptions } = await import('../mcp-server.js');

const CONFIG: HitlConfig = {
  topicId: 'test-topic',
  ntfyUrl: 'https://ntfy.example.test',
  deviceName: 'test-device',
  soundEnabled: false,
  identityEnabled: false,
};

type CallTool = (request: unknown, extra: unknown) => Promise<unknown>;

function toolHandler(server: InstanceType<typeof HumanInTheLoopServer>): CallTool {
  const handlers = (
    server as unknown as { server: { _requestHandlers: Map<string, unknown> } }
  ).server._requestHandlers;
  return handlers.get('tools/call') as CallTool;
}

function close(server: InstanceType<typeof HumanInTheLoopServer>): void {
  (server as unknown as { transport: { close: () => void } }).transport.close();
}

describe('--no-auto-launch-client server behavior', () => {
  const realFetch = globalThis.fetch;
  let published: string[];

  beforeEach(() => {
    jest.clearAllMocks();
    published = [];
    globalThis.fetch = jest.fn(async (_url: unknown, init?: RequestInit) => {
      if (typeof init?.body === 'string') published.push(init.body);
      return { ok: true, status: 200, statusText: 'OK', text: async () => '' } as Response;
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('parses only the explicit opt-out argument', () => {
    expect(parseServerOptions(['--no-auto-launch-client'])).toEqual({ autoLaunchClient: false });
    expect(parseServerOptions([])).toEqual({ autoLaunchClient: true });
    expect(parseServerOptions(['--unrelated'])).toEqual({ autoLaunchClient: true });
  });

  it('lets Notify publish when no local client is available', async () => {
    const server = new HumanInTheLoopServer(CONFIG, { autoLaunchClient: false });
    try {
      const result = await toolHandler(server)(
        { method: 'tools/call', params: { name: 'Notify', arguments: { title: 'Done', body: 'Ready' } } },
        {}
      ) as { content: Array<{ text: string }> };

      expect(JSON.parse(result.content[0].text)).toMatchObject({ success: true });
      expect(JSON.parse(published[0])).toMatchObject({ type: 'notification', title: 'Done', body: 'Ready' });
      expect(mockEnsureClientRunning).not.toHaveBeenCalled();
    } finally {
      close(server);
    }
  });

  it('lets AskUserQuestion publish and enter its remote wait', async () => {
    const server = new HumanInTheLoopServer(CONFIG, { autoLaunchClient: false });
    try {
      await expect(toolHandler(server)(
        {
          method: 'tools/call',
          params: {
            name: 'AskUserQuestion',
            arguments: {
              context: 'remote inbox test',
              question: 'Proceed?',
              options: [{ label: 'Yes', value: 'yes' }],
            },
          },
        },
        { signal: AbortSignal.abort() }
      )).rejects.toThrow(/wait cancelled before response/i);

      expect(JSON.parse(published[0])).toMatchObject({ type: 'question', question: 'Proceed?' });
      expect(mockEnsureClientRunning).not.toHaveBeenCalled();
    } finally {
      close(server);
    }
  });

  it('lets ReviewPlan publish and enter its remote wait', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hitl-no-auto-launch-'));
    const planPath = path.join(dir, 'plan.md');
    writeFileSync(planPath, '# Plan\n\n- ship it\n', 'utf8');
    const server = new HumanInTheLoopServer(CONFIG, { autoLaunchClient: false });
    try {
      await expect(toolHandler(server)(
        {
          method: 'tools/call',
          params: { name: 'ReviewPlan', arguments: { filePath: planPath, context: 'remote inbox test' } },
        },
        { signal: AbortSignal.abort(), sendNotification: async () => {} }
      )).rejects.toThrow(/wait cancelled before response/i);

      expect(JSON.parse(published[0])).toMatchObject({ type: 'plan_review' });
      expect(mockEnsureClientRunning).not.toHaveBeenCalled();
    } finally {
      close(server);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes the opt-out through setup and reports the skipped client step', async () => {
    const server = new HumanInTheLoopServer(CONFIG, { autoLaunchClient: false });
    try {
      const result = await toolHandler(server)(
        { method: 'tools/call', params: { name: 'setup', arguments: {} } },
        {}
      ) as { content: Array<{ text: string }> };

      expect(JSON.parse(result.content[0].text)).toMatchObject({
        success: true,
        steps: [{ step: 'client', status: 'skipped' }],
      });
    } finally {
      close(server);
    }
  });

  it('keeps local client enforcement enabled by default', async () => {
    const server = new HumanInTheLoopServer(CONFIG);
    try {
      await expect(toolHandler(server)(
        { method: 'tools/call', params: { name: 'Notify', arguments: { title: 'Done', body: 'Ready' } } },
        {}
      )).rejects.toThrow(/no hitl client available/i);
      expect(published).toHaveLength(0);
    } finally {
      close(server);
    }
  });
});
