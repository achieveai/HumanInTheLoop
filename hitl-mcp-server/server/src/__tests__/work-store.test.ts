import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { WorkStore, type UpdateWorkInput } from '../work-store.js';

let home: string;
beforeEach(() => { home = mkdtempSync(path.join(tmpdir(), 'hitl-work-')); });
afterEach(() => rmSync(home, { recursive: true, force: true }));
const input = (taskId = 'root', parentTaskId: string | null = null): UpdateWorkInput => ({
  workId: 'work', updateId: taskId, expectedRevision: 0, title: 'Build', goal: 'Ship',
  task: { taskId, parentTaskId, owner: 'agent', reportedBy: 'agent', status: 'in_progress', completed: [], learnings: [], current: { action: 'Build', purpose: 'Ship' }, remaining: [], blockers: [] },
});
const store = (topic = 'topic') => new WorkStore({ topicId: topic, ntfyUrl: 'https://ntfy.sh' }, home);
test('persists full trees, independently revisions children and isolates topics', async () => {
  await store().update(input(), async () => {});
  await Promise.all(['a', 'b'].map(id => store().update(input(id, 'root'), async () => {})));
  const doc = store().read('work');
  expect(doc.revision).toBe(3);
  expect(doc.tasks.map(t => t.taskId).sort()).toEqual(['a', 'b', 'root']);
  expect(doc.tasks.every(t => t.revision === 1)).toBe(true);
  expect(() => store('other').read('work')).toThrow(/not found/);
});
test('retries a saved publish failure with stable identity and no new revision', async () => {
  const failed = await store().update(input(), async () => { throw new Error('offline'); });
  expect(failed).toMatchObject({ saved: true, published: false, publishError: 'offline' });
  const retried = await store().update(input(), async msg => { expect(msg.messageId).toBe(failed.messageId); });
  expect(retried).toMatchObject({ saved: true, published: true, messageId: failed.messageId });
  expect(retried.document.revision).toBe(1);
  await expect(store().update({ ...input(), summary: 'different' }, async () => {})).rejects.toThrow(/updateId/);
});
test('rejects stale updates, absent parents, additional roots and cycles', async () => {
  await store().update(input(), async () => {});
  await expect(store().update({ ...input(), updateId: 'stale' }, async () => {})).rejects.toThrow(/revision/i);
  await expect(store().update(input('orphan', 'missing'), async () => {})).rejects.toThrow(/parent/i);
  await expect(store().update(input('other'), async () => {})).rejects.toThrow(/root/i);
  await store().update(input('child', 'root'), async () => {});
  const cycle = input(); cycle.updateId = 'cycle'; cycle.expectedRevision = 1; cycle.task.parentTaskId = 'child';
  await expect(store().update(cycle, async () => {})).rejects.toThrow(/root|cycle/i);
});
test('rejects oversized and malformed reports before storing', async () => {
  await expect(store().update({ ...input(), goal: 'a'.repeat(70000) }, async () => {})).rejects.toThrow(/limit|large/);
  const bad = input(); bad.task.status = 'unknown' as never;
  await expect(store().update(bad, async () => {})).rejects.toThrow(/status/);
});

test('independent OS processes preserve every child update', async () => {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const run = promisify(execFile);
  await store().update(input(), async () => {});
  const moduleUrl = new URL('../work-store.ts', import.meta.url).href;
  await Promise.all(Array.from({ length: 8 }, (_, i) => {
    const script = `import { WorkStore } from ${JSON.stringify(moduleUrl)}; const s = new WorkStore({topicId:'topic',ntfyUrl:'https://ntfy.sh'}, ${JSON.stringify(home)}); await s.update(${JSON.stringify(input('process-' + i, 'root'))}, async () => {});`;
    return run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script]);
  }));
  expect(store().read('work').tasks).toHaveLength(9);
  expect(store().history('work').map(d => d.revision)).toEqual([1,2,3,4,5,6,7,8,9]);
}, 30000);

test('old retry returns newest document without republishing an acknowledged update', async () => {
  await store().update(input(), async () => {});
  await store().update(input('child', 'root'), async () => {});
  const result = await store().update(input(), async () => { throw new Error('must not republish'); });
  expect(result.document.revision).toBe(2);
  expect(result.publishedRevision).toBe(1);
  expect(result.publishError).toBeUndefined();
});

test('keeps task display order and restricts root metadata changes', async () => {
  await store().update(input(), async () => {});
  await store().update(input('a', 'root'), async () => {});
  await store().update(input('b', 'root'), async () => {});
  await store().update({ ...input('a', 'root'), updateId: 'a-next', expectedRevision: 1 }, async () => {});
  expect(store().read('work').tasks.map(t => t.taskId)).toEqual(['root', 'a', 'b']);
  await expect(store().update({ ...input('b', 'root'), updateId: 'metadata', expectedRevision: 1, title: 'Hijacked' }, async () => {})).rejects.toThrow(/root metadata/);
});
