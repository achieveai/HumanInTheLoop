import { createHash, randomBytes } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { resolveRepoRoot, normalizePath, toRepoRelative } from './git-context.js';

/**
 * On-disk revision history for reviewed plans.
 *
 *   ~/.hitl/plans/<sha256(identityKey)>/<sha256(normalizedPath)>/
 *     latest.json          {displayPath, digest, revision, createdAt}
 *     objects/<sha256>     immutable content, one file per unique revision
 *     drafts/<planId>.json in-flight comments — written by the client, not here
 *
 * Deliberately lock-free. Two MCP server processes reviewing the same plan can
 * race `latest.json`, but `objects/<sha256>` is content-addressed and immutable,
 * so a lost race costs cosmetic staleness (whose revision is called "latest"),
 * never corruption. Last writer wins.
 *
 * Crash safety is the atomic temp-file + rename on `latest.json` (B-9): the
 * object lands first, then the pointer flips in one operation, so an
 * interrupted write leaves the previous `latest.json` byte-identical.
 */

/** The trusted contents of `latest.json`. */
export interface SnapshotMeta {
  /** Repo-relative display path — never absolute (F-9). */
  displayPath: string;
  /** Bare lowercase sha256 hex of the content. `snapshotHash` prefixes it with 'sha256:'. */
  digest: string;
  revision: number;
  /** Unix millis. */
  createdAt: number;
}

/** Where a given plan file's history lives, and how it is named on the wire. */
export interface PlanIdentity {
  /** Stable across revisions; keys drafts. */
  planId: string;
  /** Absolute directory holding latest.json / objects / drafts. */
  dir: string;
  /** Repo-relative when the plan is inside a repo, else just the basename (F-9). */
  displayPath: string;
  /** Absolute repo root, or null when the plan is not in a work tree. */
  repoRoot: string | null;
  /** The resolved, symlink-free plan path this identity describes. */
  resolvedPath: string;
}

/** Outcome of recording a revision. */
export interface RecordedRevision {
  revision: number;
  /** Bare sha256 hex of the content just recorded. */
  digest: string;
  isNewPlan: boolean;
  /** The revision this one supersedes, or null on a first review. */
  previous: SnapshotMeta | null;
  /** Content of `previous`, or null when there is none / the object is missing. */
  previousContent: string | null;
}

/** A revision whose content is stored but which is not yet the plan's latest. */
export interface PreparedRevision extends RecordedRevision {
  /**
   * Flip `latest.json` to this revision, making it the baseline the next review
   * diffs against. Until this is called the object sits in `objects/` and the
   * plan's history is unchanged.
   */
  commit(): RecordedRevision;
}

/** Root of the snapshot store. Overridable so tests never touch a real home dir. */
export function getPlansRoot(): string {
  return path.join(process.env.HITL_HOME ?? path.join(homedir(), '.hitl'), 'plans');
}

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Locate a plan file's history directory and its display name.
 *
 * Identity is keyed on the repo root when there is one, else on the containing
 * directory — so the same relative path in two different repos gets two
 * identities (B-7), while two spellings of one Windows path collapse to one
 * (B-10). Git is resolved from the plan's own directory, never `process.cwd()`,
 * because the plan usually lives in a sibling repo (B-6).
 */
export function resolvePlanIdentity(resolvedPath: string): PlanIdentity {
  const normalizedPath = normalizePath(resolvedPath);
  const dirName = path.dirname(resolvedPath);
  const repoRoot = resolveRepoRoot(dirName);
  const identityKey = repoRoot ?? normalizePath(dirName);

  const identityHash = sha256Hex(identityKey);
  const pathHash = sha256Hex(normalizedPath);

  return {
    planId: sha256Hex(`${identityHash}:${pathHash}`),
    dir: path.join(getPlansRoot(), identityHash, pathHash),
    displayPath: repoRoot ? toRepoRelative(repoRoot, resolvedPath) : path.basename(resolvedPath),
    repoRoot,
    resolvedPath,
  };
}

/**
 * Validate a raw `latest.json` body before anything trusts it.
 *
 * Returns null — never a partially-trusted object — when the digest is not 64
 * lowercase hex, the revision is not a positive integer, `createdAt` is zero,
 * or the recorded `displayPath` names a different file than the one being
 * reviewed. A rejected pointer degrades to "no history", which restarts the
 * revision count rather than diffing against something unverified.
 */
export function parseLatest(raw: string, expectedDisplayPath: string): SnapshotMeta | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const { displayPath, digest, revision, createdAt } = parsed as Record<string, unknown>;

  if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) return null;
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) return null;
  if (typeof createdAt !== 'number' || createdAt <= 0) return null;
  if (typeof displayPath !== 'string' || displayPath !== expectedDisplayPath) return null;

  return { displayPath, digest, revision, createdAt };
}

/** Read and validate `latest.json`, or null when absent or untrustworthy. */
export function readLatest(identity: PlanIdentity): SnapshotMeta | null {
  const file = path.join(identity.dir, 'latest.json');
  if (!existsSync(file)) return null;

  try {
    return parseLatest(readFileSync(file, 'utf8'), identity.displayPath);
  } catch {
    return null;
  }
}

/** Read a stored revision by digest, or null when the object is missing. */
export function readObject(identity: PlanIdentity, digest: string): string | null {
  const file = path.join(identity.dir, 'objects', digest);
  if (!existsSync(file)) return null;

  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Stage `content` as the next revision of this plan.
 *
 * Byte-identical content still advances the revision: a resubmit is a distinct
 * review event, and the human must still be able to select every line of an
 * unchanged plan (B-3).
 *
 * The pointer flip is deliberately a separate step. `latest.json` is what the
 * next review diffs against, so writing it before the plan has actually reached
 * the human means a failed publish silently rebases the next review onto a
 * revision nobody ever saw — the change the human was meant to review vanishes
 * from the diff (M6). Callers commit once the revision is out the door.
 *
 * The object is written either way; it is content-addressed and immutable, so
 * an uncommitted one costs a few KB of orphaned disk and nothing else.
 */
export function prepareRevision(identity: PlanIdentity, content: string): PreparedRevision {
  mkdirSync(path.join(identity.dir, 'objects'), { recursive: true, mode: DIR_MODE });
  // The client writes drafts here; the directory is part of the layout either way.
  mkdirSync(path.join(identity.dir, 'drafts'), { recursive: true, mode: DIR_MODE });

  const previous = readLatest(identity);
  const previousContent = previous ? readObject(identity, previous.digest) : null;

  const digest = sha256Hex(content);
  const objectFile = path.join(identity.dir, 'objects', digest);
  if (!existsSync(objectFile)) {
    writeAtomic(objectFile, content);
  }

  const record: RecordedRevision = {
    revision: (previous?.revision ?? 0) + 1,
    digest,
    isNewPlan: previous === null,
    previous,
    previousContent,
  };

  return {
    ...record,
    commit(): RecordedRevision {
      const meta: SnapshotMeta = {
        displayPath: identity.displayPath,
        digest,
        revision: record.revision,
        createdAt: Date.now(),
      };
      writeAtomic(path.join(identity.dir, 'latest.json'), JSON.stringify(meta, null, 2) + '\n');
      return record;
    },
  };
}

/**
 * Write via a temp file in the same directory, then rename over the target.
 *
 * `renameSync` maps to MoveFileEx with MOVEFILE_REPLACE_EXISTING on Windows, so
 * replacing an existing destination is atomic there too. The temp file is
 * removed on failure so a full disk cannot leave debris behind.
 *
 * The temp name must be unique per write, not per target. A shared name lets a
 * second writer append into the first one's half-written file and then rename
 * the torn result into place — which is precisely the corruption this function
 * claims to prevent, and it is reproducible with two concurrent writers.
 *
 * Rename can also fail with EPERM on Windows when another process has the
 * destination open for reading, which is ordinary here: every ReviewPlan reads
 * `latest.json`. That is transient, so `renameWithRetry` absorbs it.
 */
function writeAtomic(file: string, contents: string): void {
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, contents, { encoding: 'utf8', mode: FILE_MODE });
    renameWithRetry(tmp, file);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw err;
  }
}

/**
 * Rename, tolerating Windows sharing violations.
 *
 * `MoveFileEx` fails with ERROR_ACCESS_DENIED (EPERM) while another process
 * holds the destination open, and every ReviewPlan reads `latest.json`, so this
 * collides in ordinary use rather than only under stress. It is transient, so
 * it is retried with jitter — without the jitter two writers that collided once
 * retry in lockstep and collide again. Anything that is not a sharing violation
 * is a real failure and is raised immediately.
 */
const RENAME_RETRY_BUDGET_MS = 5_000;

function renameWithRetry(from: string, to: string): void {
  const started = Date.now();
  let delay = 2;
  for (;;) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const transient = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
      if (!transient || Date.now() - started >= RENAME_RETRY_BUDGET_MS) throw err;
      sleepSync(delay + Math.floor(Math.random() * delay));
      delay = Math.min(delay * 2, 250);
    }
  }
}

/**
 * Block for `ms`, without an event-loop turn.
 *
 * The whole store is synchronous so that a snapshot is durable before the
 * caller can act on it; a promise here would let a second write interleave.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
