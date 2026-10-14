import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { randomBytes } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { HumanInTheLoopServer } from '../mcp-server.js';
import type { HitlConfig, SenderIdentityMessage } from '../types.js';

const CONFIG: HitlConfig = {
  topicId: 'topic-under-test',
  ntfyUrl: 'https://ntfy.sh',
  deviceName: 'test-device',
  soundEnabled: false,
  encryptionKey: randomBytes(32).toString('hex'),
};

type Content = Array<{ type: string; text: string }>;

let home: string;
let savedSessionId: string | undefined;
let servers: HumanInTheLoopServer[];
let identities: SenderIdentityMessage[];

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'hitl-names-'));
  process.env.HITL_HOME = home;
  savedSessionId = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'session-under-test';
  servers = [];
  identities = [];
});

afterEach(() => {
  for (const server of servers) (server as unknown as { transport: { close: () => void } }).transport.close();
  if (savedSessionId === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
  else process.env.CLAUDE_CODE_SESSION_ID = savedSessionId;
  delete process.env.HITL_HOME;
  rmSync(home, { recursive: true, force: true });
});

/** A server whose transport records sender identities and answers HandOff with `end`. */
function startServer(): (name: string, args: Record<string, unknown>) => Promise<Content> {
  const server = new HumanInTheLoopServer(CONFIG);
  servers.push(server);
  const internals = server as unknown as Record<string, unknown> & {
    transport: Record<string, unknown> & { pending: Record<string, unknown> };
    server: { _requestHandlers: Map<string, unknown> };
  };
  internals.requireClient = () => {};
  internals.transport.publish = async () => {};
  internals.transport.publishHandoff = async () => {};
  internals.transport.publishSenderIdentity = async (msg: SenderIdentityMessage) => { identities.push(msg); };
  internals.transport.pending.record = () => {};
  internals.transport.pending.clear = () => {};
  internals.transport.waitForAnswer = async () => ({ respondedFrom: 'phone', timestamp: 1, selectedValues: ['end'] });
  const handler = internals.server._requestHandlers.get('tools/call') as (req: unknown, extra: unknown) =>
    Promise<{ content: Content }>;
  return async (name, args) =>
    (await handler({ method: 'tools/call', params: { name, arguments: args } }, { signal: new AbortController().signal })).content;
}

const NAME = { name: 'Inbox repaint fix', objective: 'Stop the Inbox list flickering on every refresh.' };

describe('NameSession', () => {
  it('saves the name, says what it replaced, and sends it to Inbox at once', async () => {
    const call = startServer();
    expect(JSON.parse((await call('NameSession', NAME))[0].text)).toEqual({ success: true, ...NAME });
    expect(identities).toHaveLength(1);
    expect(identities[0]).toMatchObject({ forType: 'session_name', sender: { sessionName: NAME.name, objective: NAME.objective } });

    const renamed = JSON.parse((await call('NameSession', { name: 'Android build', objective: 'Build the APK.' }))[0].text);
    expect(renamed).toMatchObject({ name: 'Android build', previousName: NAME.name });
  });

  it('puts the name and objective on every later message', async () => {
    const call = startServer();
    await call('NameSession', NAME);
    await call('Notify', { title: 'Build done', body: 'ok' });
    expect(identities.at(-1)).toMatchObject({ forType: 'notification', sender: { sessionName: NAME.name, objective: NAME.objective } });
  });

  it('keeps the name when the server restarts', async () => {
    await startServer()('NameSession', NAME);
    await startServer()('Notify', { title: 'Build done', body: 'ok' });
    expect(identities.at(-1)?.sender.sessionName).toBe(NAME.name);
  });

  it('refuses a name too long to read at a glance, saving nothing', async () => {
    const call = startServer();
    await expect(call('NameSession', { name: 'x'.repeat(41), objective: 'o' })).rejects.toThrow(/shorten it to 40/);
    await expect(call('NameSession', { name: 'ok' })).rejects.toThrow(/objective/);
    await call('Notify', { title: 't', body: 'b' });
    expect(identities.at(-1)?.sender.sessionName).toBeUndefined();
  });
});

describe('the name reminder', () => {
  it('nudges an unnamed session after a tool call, and stops once it is named', async () => {
    const call = startServer();
    const before = await call('Notify', { title: 't', body: 'b' });
    expect(before).toHaveLength(2);
    expect(JSON.parse(before[0].text)).toMatchObject({ success: true });
    expect(before[1].text).toMatch(/no name yet\. Call NameSession/);

    await call('NameSession', NAME);
    expect(await call('Notify', { title: 't', body: 'b' })).toHaveLength(1);
  });

  it('asks a named session at HandOff whether its objective still holds', async () => {
    const call = startServer();
    await call('NameSession', NAME);
    const result = await call('HandOff', { title: 'Done', summary: 'ok', context: 'Hitl_MCP' });
    expect(JSON.parse(result[0].text)).toMatchObject({ action: 'end' });
    expect(result[1].text).toContain(`"${NAME.name}": ${NAME.objective}`);
    expect(result[1].text).toMatch(/call NameSession again/);
  });

  it('stays quiet when the operator turned identity off', async () => {
    const call = startServer();
    (servers[0] as unknown as { config: HitlConfig }).config = { ...CONFIG, identityEnabled: false };
    expect(await call('Notify', { title: 't', body: 'b' })).toHaveLength(1);
  });
});
