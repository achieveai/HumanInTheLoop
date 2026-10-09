import { createHash } from 'crypto';
import {
  appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'fs';
import { homedir } from 'os';
import path from 'path';
import { hitlDir } from '../config.js';
import { mergeMemoryFile } from './merge3.js';

/** Files larger than this are not synced; real memory files are a few KB. */
export const MAX_FILE_BYTES = 256 * 1024;

export type ReplicaHost = 'claude' | 'codex' | 'copilot';

export interface Replica {
  path: string;
  host: ReplicaHost;
}

export interface SyncResult {
  /** Files whose content changed anywhere during this pass. */
  changed: string[];
  /** Files where both sides edited the same lines and both were kept. */
  clashed: string[];
  /** Files left alone because they are too big. */
  skipped: string[];
}

/** `~/.hitl/memory`, or `HITL_MEMORY_ROOT` for tests and trial runs. */
export function memoryRoot(): string {
  return process.env.HITL_MEMORY_ROOT || path.join(hitlDir(), 'memory');
}

/** Where Claude keeps a folder's memory: `~/.claude/projects/<slug>/memory`. */
export function claudeMemoryDir(cwd: string): string | null {
  // Claude's own rule; past 200 chars it appends a hash we cannot reproduce.
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  if (slug.length > 200) return null;
  const projects = process.env.HITL_CLAUDE_PROJECTS_DIR || path.join(homedir(), '.claude', 'projects');
  return path.join(projects, slug, 'memory');
}

const safeKey = (key: string) => key.replace(/[^a-z0-9._/-]/gi, '_');
export const sharedDir = (key: string) => path.join(memoryRoot(), safeKey(key));
const syncDir = (key: string) => path.join(memoryRoot(), '.sync', safeKey(key));
const replicaId = (replicaPath: string) =>
  createHash('sha256').update(path.resolve(replicaPath).toLowerCase()).digest('hex').slice(0, 16);

type Registry = Record<string, Record<string, Replica>>;
const registryPath = () => path.join(memoryRoot(), '.sync', 'registry.json');

export function readRegistry(): Registry {
  try {
    return JSON.parse(readFileSync(registryPath(), 'utf8')) as Registry;
  } catch {
    return {};
  }
}

/** Remember a replica so later passes keep it in step. Only the lock holder calls this. */
export function registerReplica(key: string, replica: Replica): void {
  const registry = readRegistry();
  const id = replicaId(replica.path);
  if (registry[key]?.[id]?.path === replica.path) return;
  registry[key] = { ...registry[key], [id]: replica };
  atomicWrite(registryPath(), JSON.stringify(registry, null, 2));
}

function read(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function atomicWrite(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.hitl-tmp`);
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

function put(file: string, text: string | null): void {
  if (text === null) rmSync(file, { force: true });
  else atomicWrite(file, text);
}

/** Memory files in `dir`: top-level `*.md` only. */
function memoryFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      .map(entry => entry.name);
  } catch {
    return [];
  }
}

function tooBig(file: string): boolean {
  try {
    return statSync(file).size > MAX_FILE_BYTES;
  } catch {
    return false;
  }
}

/**
 * One differential-sync pass between a replica and the repo's shared folder.
 *
 * Each file has a shadow: the last content both sides agreed on. A side that
 * differs from the shadow has changed. One side changed: copy it. Both changed:
 * merge against the shadow, shared first, keeping both on a clash. An edit
 * beats a delete. Afterwards all three hold the same bytes.
 *
 * The replica is written last and only if the agent has not touched it since it
 * was read; otherwise that file waits for the next pass, which merges again.
 */
export function syncReplica(key: string, replica: Replica): SyncResult {
  const shared = sharedDir(key);
  const shadows = path.join(syncDir(key), 'shadows', replicaId(replica.path));
  const result: SyncResult = { changed: [], clashed: [], skipped: [] };

  if (!existsSync(shadows) && memoryFiles(replica.path).length > 0) {
    // First contact with a folder that already holds memories: keep a copy.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    cpSync(replica.path, path.join(syncDir(key), 'backups', `${replicaId(replica.path)}-${stamp}`), { recursive: true });
  }
  mkdirSync(shadows, { recursive: true });

  const names = new Set([...memoryFiles(replica.path), ...memoryFiles(shared), ...memoryFiles(shadows)]);
  for (const name of [...names].sort()) {
    const files = { s: path.join(shadows, name), r: path.join(replica.path, name), c: path.join(shared, name) };
    if (tooBig(files.r) || tooBig(files.c)) {
      result.skipped.push(name);
      continue;
    }
    const s = read(files.s);
    const r = read(files.r);
    const c = read(files.c);
    if (r === s && c === s) continue;

    let next: string | null;
    if (c === s) next = r;
    else if (r === s) next = c;
    else if (r === null || c === null) next = r ?? c;
    else {
      const merged = mergeMemoryFile(s ?? '', c, r);
      next = merged.text;
      if (merged.clashed) result.clashed.push(name);
    }

    if (c !== next) put(files.c, next);
    if (r !== next) {
      if (read(files.r) !== r) continue; // the agent wrote it meanwhile; next pass merges
      put(files.r, next);
    }
    put(files.s, next);
    result.changed.push(name);
  }

  if (result.clashed.length > 0) {
    const line = JSON.stringify({ at: new Date().toISOString(), replica: replica.path, files: result.clashed });
    appendFileSync(path.join(syncDir(key), 'clashes.jsonl'), `${line}\n`);
  }
  return result;
}

/**
 * A replica whose clone is gone (a removed worktree). Claude's folders are never
 * gone in this sense: Claude creates them lazily, so a missing one is just new.
 */
function isOrphan(replica: Replica): boolean {
  return replica.host !== 'claude' && !existsSync(path.dirname(path.dirname(replica.path)));
}

/** Sync every registered replica of `key`, dropping ones whose clone is gone. */
export function syncKey(key: string): SyncResult {
  const total: SyncResult = { changed: [], clashed: [], skipped: [] };
  const registry = readRegistry();
  for (const [id, replica] of Object.entries(registry[key] ?? {})) {
    if (isOrphan(replica)) {
      delete registry[key][id];
      atomicWrite(registryPath(), JSON.stringify(registry, null, 2));
      continue;
    }
    const one = syncReplica(key, replica);
    total.changed.push(...one.changed);
    total.clashed.push(...one.clashed);
    total.skipped.push(...one.skipped);
  }
  // A second pass carries one replica's change to the replicas synced before it.
  if (total.changed.length > 0) {
    for (const replica of Object.values(readRegistry()[key] ?? {})) syncReplica(key, replica);
  }
  const unique = (names: string[]) => [...new Set(names)].sort();
  return { changed: unique(total.changed), clashed: unique(total.clashed), skipped: unique(total.skipped) };
}

/** Sync every repo this machine knows about. */
export function syncAll(): void {
  for (const key of Object.keys(readRegistry())) syncKey(key);
}
