import { execSync } from 'child_process';
import type { RepoContext } from './types.js';

/**
 * Auto-detect git repository context from the current working directory.
 * Returns null fields gracefully if git is unavailable or not in a repo.
 */
export function detectRepoContext(cwd?: string): RepoContext | null {
  const opts = { cwd: cwd ?? process.cwd(), encoding: 'utf-8' as const, timeout: 5000 };

  try {
    // Quick check: are we in a git repo at all?
    execSync('git rev-parse --is-inside-work-tree', { ...opts, stdio: 'pipe' });
  } catch {
    return null;
  }

  const run = (cmd: string): string | undefined => {
    try {
      return execSync(cmd, { ...opts, stdio: 'pipe' }).trim() || undefined;
    } catch {
      return undefined;
    }
  };

  const toplevel = run('git rev-parse --show-toplevel');
  const name = toplevel ? toplevel.split('/').pop() ?? toplevel.split('\\').pop() ?? 'unknown' : 'unknown';
  const branch = run('git branch --show-current') ?? 'HEAD';
  const remoteUrl = run('git remote get-url origin');

  return { name, branch, remoteUrl };
}
