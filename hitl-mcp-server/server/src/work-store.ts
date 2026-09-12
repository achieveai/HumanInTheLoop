import { createHash, randomUUID } from 'crypto';
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';

export interface WorkTask {
  taskId: string; parentTaskId: string | null; revision: number;
  owner: string; reportedBy: string;
  status: 'pending' | 'in_progress' | 'blocked' | 'completed' | 'cancelled';
  completed: string[]; learnings: string[]; current: { action: string; purpose: string } | null;
  remaining: string[]; blockers: string[]; reportedAt: number;
}
export interface WorkDocument {
  workId: string; title: string; goal: string; rootTaskId: string; revision: number;
  updatedAt: number; changes: string[]; tasks: WorkTask[];
}
export interface WorkUpdateMessage {
  type: 'work_update'; messageId: string; timestamp: number; workId: string;
  revision: number; title: string; body: string; alert: boolean; document: WorkDocument;
}
export interface UpdateWorkInput {
  workId: string; updateId: string; expectedRevision: number; title?: string; goal?: string;
  task: Omit<WorkTask, 'revision' | 'reportedAt'>; changes?: string[]; summary?: string; alert?: boolean;
}
interface RecordEntry { updateId: string; fingerprint: string; message: WorkUpdateMessage }
export class WorkValidationError extends Error {}
const MAX_BYTES = 64 * 1024;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
function fail(message: string): never { throw new WorkValidationError(message); }
function text(value: unknown, field: string, limit = 4000): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) fail(`${field} must be nonempty text within ${limit} character limit`);
}
function list(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value) || value.length > 100) fail(`${field} must be an array (limit 100)`);
  for (const item of value) text(item, field);
}
/** Canonical keys make retry identity independent of JSON object property order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value);
}
export function validateUpdate(value: unknown): asserts value is UpdateWorkInput {
  if (!value || typeof value !== 'object') fail('UpdateWork requires an object');
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) fail('Update exceeds 64 KiB limit');
  const v = value as UpdateWorkInput;
  text(v.workId, 'workId', 200); text(v.updateId, 'updateId', 200);
  if (!Number.isSafeInteger(v.expectedRevision) || v.expectedRevision < 0) fail('expectedRevision must be a nonnegative integer');
  if (v.title !== undefined) text(v.title, 'title', 300);
  if (v.goal !== undefined) text(v.goal, 'goal');
  if (v.summary !== undefined && (typeof v.summary !== 'string' || v.summary.length > 4000)) fail('summary exceeds limit or is not text');
  if (v.alert !== undefined && typeof v.alert !== 'boolean') fail('alert must be boolean');
  if (v.changes !== undefined) list(v.changes, 'changes');
  const t = v.task;
  if (!t || typeof t !== 'object') fail('task is required');
  text(t.taskId, 'taskId', 200); text(t.owner, 'owner', 200); text(t.reportedBy, 'reportedBy', 200);
  if (t.parentTaskId !== null) text(t.parentTaskId, 'parentTaskId', 200);
  if (!['pending', 'in_progress', 'blocked', 'completed', 'cancelled'].includes(t.status)) fail('Invalid task status');
  for (const field of ['completed', 'learnings', 'remaining', 'blockers'] as const) list(t[field], field);
  if (t.current !== null) {
    if (!t.current || typeof t.current !== 'object') fail('current must be an action/purpose object or null');
    text(t.current.action, 'current.action'); text(t.current.purpose, 'current.purpose');
  }
}

/**
 * Single-host, topic-scoped immutable journal. Linking a fully flushed temporary
 * file to the next revision name is the atomic compare-and-swap. No lock can be
 * stranded by a killed process. Readers see only complete records. Requires a
 * local filesystem with atomic hard links (including NTFS); never falls back to
 * unsafe overwrites. Leftover .tmp files are ignored after restart.
 */
export class WorkStore {
  private readonly root: string;
  constructor(config: { topicId: string; ntfyUrl: string }, home = process.env.HITL_HOME ?? path.join(homedir(), '.hitl')) {
    this.root = path.join(home, 'work', hash(`${config.ntfyUrl.replace(/\/$/, '')}\n${config.topicId}`));
  }
  private dir(workId: string): string { text(workId, 'workId', 200); return path.join(this.root, hash(workId)); }
  private records(dir: string): RecordEntry[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter(n => /^\d+\.json$/.test(n)).sort((a,b) => parseInt(a) - parseInt(b)).map(n => JSON.parse(readFileSync(path.join(dir, n), 'utf8')) as RecordEntry);
  }
  read(workId: string): WorkDocument {
    const entries = this.records(this.dir(workId));
    if (!entries.length) fail(`Work not found: ${workId}`);
    return entries[entries.length - 1].message.document;
  }
  /** Full revision snapshots are retained locally for audit and recovery. */
  history(workId: string): WorkDocument[] { return this.records(this.dir(workId)).map(e => e.message.document); }
  private commit(file: string, value: unknown): boolean {
    const temporary = `${file}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
    try { linkSync(temporary, file); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
    finally { unlinkSync(temporary); }
  }
  async update(raw: unknown, publish: (message: WorkUpdateMessage) => Promise<void>) {
    validateUpdate(raw);
    // Detach caller-owned data before awaiting network I/O or constructing history.
    const input = JSON.parse(JSON.stringify(raw)) as UpdateWorkInput;
    const dir = this.dir(input.workId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const fingerprint = hash(canonical(input));
    let entry: RecordEntry | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      const entries = this.records(dir);
      entry = entries.find(e => e.updateId === input.updateId);
      if (entry) {
        if (entry.fingerprint !== fingerprint) fail('updateId already used with different content');
        break;
      }
      const previous = entries.at(-1)?.message.document;
      const oldTask = previous?.tasks.find(t => t.taskId === input.task.taskId);
      if ((oldTask?.revision ?? 0) !== input.expectedRevision) fail(`Task revision conflict: expected ${input.expectedRevision}, current ${oldTask?.revision ?? 0}`);
      if (!previous && (!input.title || !input.goal || input.task.parentTaskId !== null)) fail('Root creation requires title, goal and null parentTaskId');
      const rootTaskId = previous?.rootTaskId ?? input.task.taskId;
      if ((input.task.taskId === rootTaskId) !== (input.task.parentTaskId === null)) fail('Only the root task may have a null parent');
      if (previous && input.task.taskId !== rootTaskId &&
          ((input.title !== undefined && input.title !== previous.title) || (input.goal !== undefined && input.goal !== previous.goal))) fail('Only the root task may change root metadata');
      const now = Date.now();
      const task: WorkTask = { ...input.task, revision: (oldTask?.revision ?? 0) + 1, reportedAt: now };
      const tasks = oldTask
        ? previous!.tasks.map(t => t.taskId === task.taskId ? task : t)
        : [...(previous?.tasks ?? []), task];
      if (tasks.length > 100) fail('Task count exceeds 100 limit');
      const byId = new Map(tasks.map(t => [t.taskId, t]));
      for (const item of tasks) {
        const seen = new Set<string>();
        let cursor: WorkTask | undefined = item;
        while (cursor) {
          if (seen.has(cursor.taskId)) fail('Parent cycle detected');
          seen.add(cursor.taskId);
          if (cursor.parentTaskId === null) break;
          const parent: WorkTask | undefined = byId.get(cursor.parentTaskId);
          if (!parent) fail('Parent task does not exist');
          cursor = parent;
        }
      }
      const document: WorkDocument = { workId: input.workId, title: input.title ?? previous!.title, goal: input.goal ?? previous!.goal, rootTaskId, revision: (previous?.revision ?? 0) + 1, updatedAt: now, changes: input.changes ?? [], tasks };
      const message: WorkUpdateMessage = { type: 'work_update', messageId: randomUUID(), timestamp: now, workId: document.workId, revision: document.revision, title: document.title, body: input.summary ?? '', alert: input.alert ?? false, document };
      if (Buffer.byteLength(JSON.stringify(message)) > MAX_BYTES) fail('Full work document exceeds 64 KiB limit');
      entry = { updateId: input.updateId, fingerprint, message };
      if (this.commit(path.join(dir, `${document.revision}.json`), entry)) break;
      entry = undefined;
    }
    if (!entry) throw new Error('Work changed too often; retry the same updateId');
    const receipt = path.join(dir, `${entry.message.revision}.published`);
    let published = existsSync(receipt);
    let publishError: string | undefined;
    if (!published) {
      try { await publish(entry.message); published = true; this.commit(receipt, { messageId: entry.message.messageId }); }
      catch (error) { publishError = error instanceof Error ? error.message : String(error); }
    }
    return { saved: true, published, messageId: entry.message.messageId, publishedRevision: published ? entry.message.revision : null, publishError, document: this.read(input.workId) };
  }
}

