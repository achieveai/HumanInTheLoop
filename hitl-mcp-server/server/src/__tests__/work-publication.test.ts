import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { NtfyTransport } from '../ntfy-transport.js';
import { decrypt } from '../crypto.js';
import { WorkStore, type UpdateWorkInput } from '../work-store.js';
import type { ChunkMessage } from '../types.js';

test('concurrent identical encrypted retries assemble intact snapshots with one logical identity', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'hitl-work-publication-'));
  const key = 'a'.repeat(64);
  const config = { topicId: 'retry', ntfyUrl: 'https://example.test', encryptionKey: key, deviceName: 'test', soundEnabled: false };
  const transport = new NtfyTransport(config);
  const store = new WorkStore(config, home);
  const originalFetch = globalThis.fetch;
  const chunks: ChunkMessage[] = [];
  // Pair each fragment's HTTP completion so both publications remain in flight
  // and arrive as 0,0,1,1,... regardless of event-loop timing.
  let release: (() => void) | undefined;
  globalThis.fetch = async (_url, init) => {
    chunks.push(JSON.parse(String(init?.body)));
    await new Promise<void>(resolve => {
      if (release) { const previous = release; release = undefined; previous(); resolve(); }
      else release = resolve;
    });
    return new Response('', { status: 200 });
  };
  const input: UpdateWorkInput = {
    workId: 'retry', updateId: 'same-update', expectedRevision: 0,
    title: 'Build', goal: 'Ship', summary: 'x'.repeat(3900),
    task: { taskId: 'root', parentTaskId: null, owner: 'agent', reportedBy: 'agent', status: 'pending', completed: [], learnings: [], current: null, remaining: [], blockers: [] },
  };
  try {
    const results = await Promise.all([store.update(input, m => transport.publishWork(m)), store.update(input, m => transport.publishWork(m))]);
    expect(results.map(r => [r.saved, r.published])).toEqual([[true, true], [true, true]]);
    expect(results[0].messageId).toBe(results[1].messageId);
    expect(store.history(input.workId)).toHaveLength(1);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.map(c => c.index)).toEqual(chunks.map((_, i) => Math.floor(i / 2)));

    // Mirrors Rust ChunkAssembler::push: replace an index in its group, remove
    // the group when complete, then decode its concatenated base64 payload.
    const groups = new Map<string, (string | null)[]>();
    const bodies: string[] = [];
    for (const chunk of chunks) {
      const parts = groups.get(chunk.groupId) ?? Array<string | null>(chunk.total).fill(null);
      groups.set(chunk.groupId, parts);
      expect(parts.length).toBe(chunk.total);
      parts[chunk.index] = chunk.data;
      if (parts.every(p => p !== null)) {
        groups.delete(chunk.groupId);
        bodies.push(Buffer.from(parts.join(''), 'base64').toString('utf8'));
      }
    }
    const messages = bodies.map(body => JSON.parse(decrypt(body, key)));
    expect(messages).toHaveLength(2);
    expect(groups.size).toBe(0);
    for (const message of messages) {
      expect(message).toMatchObject({ type: 'work_update', messageId: results[0].messageId, workId: input.workId, revision: 1, document: results[0].document });
    }
    await store.update(input, async () => { throw new Error('Acknowledged retry must not publish'); });
    expect(store.history(input.workId)).toHaveLength(1);
  } finally {
    globalThis.fetch = originalFetch;
    transport.close();
    rmSync(home, { recursive: true, force: true });
  }
});
