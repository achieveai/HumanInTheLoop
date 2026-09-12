import { jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { HumanInTheLoopServer } from '../mcp-server.js';
import { decrypt } from '../crypto.js';

test('MCP exposes tools, publishes encrypted full snapshot and reads durable state', async () => {
  const previousHome = process.env.HITL_HOME;
  const home = mkdtempSync(path.join(tmpdir(), 'hitl-work-tools-'));
  process.env.HITL_HOME = home;
  const previousFetch = globalThis.fetch;
  const bodies: string[] = [];
  globalThis.fetch = jest.fn(async (_url: unknown, init?: RequestInit) => {
    bodies.push(init!.body as string);
    return { ok: true, status: 200 } as Response;
  }) as typeof fetch;
  const key = 'a'.repeat(64);
  const server = new HumanInTheLoopServer({ topicId: 'test-work', ntfyUrl: 'https://example.test', deviceName: 'test', soundEnabled: false, encryptionKey: key }, { autoLaunchClient: false });
  const internals = server as unknown as { server: { _requestHandlers: Map<string, (r: unknown, e: unknown) => Promise<{content: {text: string}[]; tools: {name:string}[]}>> }; transport: {close(): void} };
  try {
    const handlers = internals.server._requestHandlers;
    const listed = await handlers.get('tools/list')!({ method: 'tools/list' }, {});
    expect(listed.tools.map(t => t.name)).toEqual(expect.arrayContaining(['Notify', 'UpdateWork', 'ReadWork']));
    const call = async (name: string, args: unknown) => JSON.parse((await handlers.get('tools/call')!({ method: 'tools/call', params: {name, arguments: args} }, {})).content[0].text);
    const result = await call('UpdateWork', { workId: 'w', updateId: 'u', expectedRevision: 0, title: 'Title', goal: 'Goal', task: { taskId: 'root', parentTaskId: null, owner: 'agent', reportedBy: 'agent', status: 'pending', completed: [], learnings: [], current: null, remaining: [], blockers: [] } });
    expect(result).toMatchObject({ saved: true, published: true });
    const message = JSON.parse(decrypt(bodies[0], key));
    expect(message).toMatchObject({ type: 'work_update', alert: false, document: result.document });
    expect(await call('ReadWork', { workId: 'w' })).toEqual({document: result.document});
    await expect(call('UpdateWork', { workId: 'w' })).rejects.toThrow(/updateId/);
    bodies.length = 0;
    await call('UpdateWork', { workId: 'large', updateId: 'large', expectedRevision: 0, title: 'Large', goal: 'Goal', summary: 'x'.repeat(3900), task: { taskId: 'root', parentTaskId: null, owner: 'agent', reportedBy: 'agent', status: 'pending', completed: [], learnings: [], current: null, remaining: [], blockers: [] } });
    expect(bodies.length).toBeGreaterThan(1);
    const chunks = bodies.map(b => JSON.parse(b));
    expect(chunks.every(c => c.type === 'chunk')).toBe(true);
    const encrypted = Buffer.from(chunks.map(c => c.data).join(''), 'base64').toString('utf8');
    expect(JSON.parse(decrypt(encrypted, key))).toMatchObject({type: 'work_update', workId: 'large', body: 'x'.repeat(3900)});
  } finally {
    internals.transport.close();
    globalThis.fetch = previousFetch;
    if (previousHome === undefined) delete process.env.HITL_HOME; else process.env.HITL_HOME = previousHome;
    rmSync(home, {recursive:true, force:true});
  }
});


