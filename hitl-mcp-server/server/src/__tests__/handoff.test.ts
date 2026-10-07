import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { randomBytes } from 'crypto';
import { HumanInTheLoopServer } from '../mcp-server.js';
import { AbortedWaitError } from '../ntfy-transport.js';
import type { HitlConfig, HandoffMessage } from '../types.js';

const CONFIG: HitlConfig = {
  topicId: 'topic-under-test',
  ntfyUrl: 'https://ntfy.sh',
  deviceName: 'test-device',
  soundEnabled: false,
  encryptionKey: randomBytes(32).toString('hex'),
};

const ARGS = { title: 'Inbox fix merged', summary: '**Outcome:** done', context: 'Hitl_MCP' };

type Answer = { skipped?: boolean; selectedValues: string[]; otherText?: string };

describe('HandOff', () => {
  let server: HumanInTheLoopServer;
  let published: HandoffMessage[];
  let nextAnswer: () => Promise<Answer>;

  beforeEach(() => {
    published = [];
    server = new HumanInTheLoopServer(CONFIG);
    const internals = server as unknown as Record<string, unknown> & {
      transport: Record<string, unknown> & { pending: Record<string, unknown> };
    };
    internals.requireClient = () => {};
    internals.publishSenderIdentityFor = async () => {};
    internals.transport.publishHandoff = jest.fn(async (msg: HandoffMessage) => { published.push(msg); });
    internals.transport.pending.record = () => {};
    internals.transport.pending.clear = () => {};
    internals.transport.waitForAnswer = async () => ({
      respondedFrom: 'phone', timestamp: 1, ...(await nextAnswer()),
    });
  });

  afterEach(() => {
    (server as unknown as { transport: { close: () => void } }).transport.close();
  });

  async function handOff(args: Record<string, unknown> = ARGS): Promise<Record<string, unknown>> {
    const callTool = (
      server as unknown as { server: { _requestHandlers: Map<string, unknown> } }
    ).server._requestHandlers.get('tools/call') as (req: unknown, extra: unknown) =>
      Promise<{ content: Array<{ text: string }> }>;
    const result = await callTool(
      { method: 'tools/call', params: { name: 'HandOff', arguments: args } },
      { signal: new AbortController().signal }
    );
    return JSON.parse(result.content[0].text);
  }

  it('publishes a handoff message carrying the title, summary and context', async () => {
    nextAnswer = async () => ({ selectedValues: ['end'] });
    await handOff();

    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      type: 'handoff',
      title: 'Inbox fix merged',
      summary: '**Outcome:** done',
      context: 'Hitl_MCP',
    });
    expect(typeof published[0].messageId).toBe('string');
  });

  it('returns continue with the typed text as the next instruction', async () => {
    nextAnswer = async () => ({ selectedValues: [], otherText: '  now add tests  ' });
    expect(await handOff()).toMatchObject({ action: 'continue', instructions: 'now add tests' });
  });

  it('returns end when End is chosen, keeping any typed text as a note', async () => {
    nextAnswer = async () => ({ selectedValues: ['end'], otherText: 'thanks' });
    expect(await handOff()).toMatchObject({ action: 'end', note: 'thanks' });
  });

  it('returns end when the user skips', async () => {
    nextAnswer = async () => ({ skipped: true, selectedValues: [], otherText: 'SKIPPED' });
    const result = await handOff();
    expect(result.action).toBe('end');
    expect(result.instructions).toBeUndefined();
  });

  it('rejects a summary longer than 1200 characters before publishing', async () => {
    await expect(handOff({ ...ARGS, summary: 'x'.repeat(1201) })).rejects.toThrow(/shorten it to 1200/);
    expect(published).toHaveLength(0);
  });

  it('rejects a missing title before publishing', async () => {
    await expect(handOff({ ...ARGS, title: ' ' })).rejects.toThrow(/Missing required parameter: title/);
    expect(published).toHaveLength(0);
  });

  it('gives the honest wait-cancelled remediation when the wait is aborted', async () => {
    nextAnswer = async () => { throw new AbortedWaitError('answer'); };
    await expect(handOff()).rejects.toThrow(/Wait cancelled before response/);
  });
});
