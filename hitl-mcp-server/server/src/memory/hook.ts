import { execFileSync } from 'child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import path from 'path';
import { resolveRepo } from './repo-key.js';
import { runLocked, type SyncRequest } from './lock.js';
import {
  claudeMemoryDir, registerReplica, syncKey, type Replica, type ReplicaHost, type SyncResult,
} from './sync.js';

/** The longest index we inject; Claude itself stops reading MEMORY.md near 25 KB. */
const MAX_INDEX_CHARS = 20_000;

/** What the lock holder does with a request: register the replica, then sync its repo. */
export function handleSync(request: SyncRequest): SyncResult {
  if (request.replica) registerReplica(request.key, request.replica);
  return syncKey(request.key);
}

/**
 * Hide `<root>/.hitl/` from git through `.git/info/exclude`: local to this
 * clone, shared by its worktrees, never committed.
 */
export function excludeFromGit(root: string): void {
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf-8', stdio: 'pipe' }).trim();
    const exclude = path.join(path.resolve(root, common), 'info', 'exclude');
    const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
    if (current.split(/\r?\n/).includes('/.hitl/')) return;
    mkdirSync(path.dirname(exclude), { recursive: true });
    const lead = current === '' || current.endsWith('\n') ? '' : '\n';
    appendFileSync(exclude, `${lead}# HITL memory replica (local only)\n/.hitl/\n`);
  } catch {
    // Not fatal: the folder is still usable, git just shows it as untracked.
  }
}

/** The replica a host keeps for a session in `cwd`, or null when it has none. */
export function replicaFor(host: ReplicaHost, cwd: string, root: string): Replica | null {
  if (host === 'claude') {
    const dir = claudeMemoryDir(cwd);
    return dir ? { path: dir, host } : null;
  }
  excludeFromGit(root);
  return { path: path.join(root, '.hitl', 'memory'), host };
}

function readIndex(dir: string): string {
  try {
    return readFileSync(path.join(dir, 'MEMORY.md'), 'utf8').slice(0, MAX_INDEX_CHARS);
  } catch {
    return '';
  }
}

/**
 * The context text a host gets at session start, or '' for none.
 * `indexBefore` is the replica's MEMORY.md before this sync ran.
 */
export function sessionContext(host: ReplicaHost, replica: Replica, indexBefore: string): string {
  const index = readIndex(replica.path).trim();
  if (host === 'claude') {
    // Claude loads its memory folder itself; speak up only when this sync changed its index.
    if (index === indexBefore.trim() || !index) return '';
    return `Your memory index was just updated by another session of this repo. Current MEMORY.md:\n\n${index}`;
  }
  return [
    `# Shared memory for this repo`,
    `Memory folder: ${replica.path}`,
    `It is shared with your other sessions, other agents (Claude, Codex, Copilot) and other machines; a sync keeps it merged.`,
    `- Read MEMORY.md (below) at the start. Open a listed file when it is relevant.`,
    `- To remember something durable, write one .md file per fact in that folder with frontmatter (name, description, metadata.type: user | feedback | project | reference), then add a line \`- [Title](file.md) — hook\` to MEMORY.md.`,
    `- Update an existing file rather than adding a duplicate. Delete memories that turn out to be wrong.`,
    `- Never store secrets.`,
    '',
    index ? `## MEMORY.md\n\n${index}` : '(No memories saved yet.)',
  ].join('\n');
}

/** Hook JSON from Claude, Codex (snake_case) or Copilot (camelCase). */
interface HookInput {
  cwd?: string;
}

/**
 * `hitl hook session-start --host <claude|codex|copilot>`: sync this repo's
 * memory into the session's replica, then hand the host its context.
 * Anything unexpected prints nothing: the session starts as it would without us.
 */
export async function runSessionStartHook(stdin: string, host: ReplicaHost): Promise<string> {
  try {
    const input = (stdin.trim() ? JSON.parse(stdin) : {}) as HookInput;
    const cwd = input.cwd || process.cwd();
    const repo = resolveRepo(cwd);
    if (!repo) return '';
    const replica = replicaFor(host, cwd, repo.root);
    if (!replica) return '';
    const indexBefore = readIndex(replica.path);
    // A busy holder must not consume the host's whole startup-hook timeout.
    try {
      await runLocked({ op: 'sync', key: repo.key, replica }, handleSync, 2000);
    } catch {
      console.error('hitl: startup memory sync unavailable; using cached memory.');
    }
    const context = sessionContext(host, replica, indexBefore);
    if (!context) return '';
    return host === 'copilot'
      ? JSON.stringify({ additionalContext: context })
      : JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } });
  } catch {
    return '';
  }
}

/** Sync the memory of the repo `cwd` is in, for `hitl memory sync` and the Stop hook. */
export async function syncFromCwd(cwd: string, host?: ReplicaHost): Promise<SyncResult | null> {
  const repo = resolveRepo(cwd);
  if (!repo) return null;
  const replica = host ? replicaFor(host, cwd, repo.root) ?? undefined : undefined;
  return (await runLocked({ op: 'sync', key: repo.key, replica }, handleSync)) as SyncResult;
}
