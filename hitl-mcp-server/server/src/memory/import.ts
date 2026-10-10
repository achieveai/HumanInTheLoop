import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { handleSync } from './hook.js';
import { runLocked } from './lock.js';
import { resolveRepo } from './repo-key.js';
import { memoryFiles, type SyncResult } from './sync.js';

export interface ImportOutcome {
  folder: string;
  key?: string;
  /** Why the folder was left alone. */
  skipped?: string;
}

/** The folder a Claude project's sessions ran in, read from its newest transcript. */
function cwdOfProject(projectDir: string): string | null {
  const transcripts = readdirSync(projectDir)
    .filter(name => name.endsWith('.jsonl'))
    .map(name => path.join(projectDir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const file of transcripts) {
    // `cwd` appears on the first few records; 64 KB is plenty.
    const buffer = Buffer.alloc(64 * 1024);
    const fd = openSync(file, 'r');
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    closeSync(fd);
    for (const line of buffer.subarray(0, length).toString('utf8').split('\n')) {
      try {
        const cwd = (JSON.parse(line) as { cwd?: unknown }).cwd;
        if (typeof cwd === 'string' && cwd) return cwd;
      } catch {
        // A partial last line, or not JSON.
      }
    }
  }
  return null;
}

/**
 * `hitl memory import`: bring every existing Claude memory folder into its
 * repo's shared memory. Each folder becomes a replica (backed up on first
 * contact), so worktrees and differently cased paths of one repo merge.
 * `dryRun` only reports what would be imported.
 */
export async function importClaudeMemory(dryRun = false): Promise<ImportOutcome[]> {
  const projects = process.env.HITL_CLAUDE_PROJECTS_DIR || path.join(homedir(), '.claude', 'projects');
  const outcomes: ImportOutcome[] = [];
  for (const name of existsSync(projects) ? readdirSync(projects).sort() : []) {
    const memory = path.join(projects, name, 'memory');
    if (memoryFiles(memory).length === 0) continue;
    const cwd = cwdOfProject(path.join(projects, name));
    if (!cwd) {
      outcomes.push({ folder: memory, skipped: 'no transcript says where it ran' });
      continue;
    }
    if (!existsSync(cwd)) {
      outcomes.push({ folder: memory, skipped: `${cwd} no longer exists` });
      continue;
    }
    const repo = resolveRepo(cwd);
    if (!repo) {
      outcomes.push({ folder: memory, skipped: `${cwd} is not in a git repo` });
      continue;
    }
    if (!dryRun) await runLocked({ op: 'sync', key: repo.key, replica: { path: memory, host: 'claude' } }, handleSync) as SyncResult;
    outcomes.push({ folder: memory, key: repo.key });
  }
  return outcomes;
}
