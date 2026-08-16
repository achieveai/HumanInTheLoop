import { execSync } from 'child_process';
import path from 'path';
import type { RepoContext } from './types.js';

/** Run a git command in `cwd`, tolerating any failure. Trims stdout; empty output ⇒ undefined. */
function run(cmd: string, cwd: string): string | undefined {
  try {
    return execSync(cmd, { cwd, encoding: 'utf-8', timeout: 5000, stdio: 'pipe' }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Auto-detect git repository context.
 *
 * `cwd` matters: a plan usually lives in a sibling repo while the agent's
 * process cwd is the workspace root, so callers with a concrete file must pass
 * `path.dirname(resolvedPlanPath)` rather than relying on the default (B-6).
 * Returns null gracefully if git is unavailable or the directory is not a repo.
 */
export function detectRepoContext(cwd?: string): RepoContext | null {
  const resolvedCwd = cwd ?? process.cwd();

  // Quick check: are we in a git repo at all?
  if (run('git rev-parse --is-inside-work-tree', resolvedCwd) === undefined) {
    return null;
  }

  const toplevel = run('git rev-parse --show-toplevel', resolvedCwd);
  const name = toplevel ? toplevel.split('/').pop() ?? toplevel.split('\\').pop() ?? 'unknown' : 'unknown';
  const branch = run('git branch --show-current', resolvedCwd) ?? 'HEAD';
  const remoteUrl = run('git remote get-url origin', resolvedCwd);

  return { name, branch, remoteUrl };
}

/**
 * Whether `cwd` is inside a *linked* git worktree (created via `git worktree add`),
 * as opposed to the main working tree or a plain non-worktree repo.
 *
 * `--git-dir` and `--git-common-dir` point at the same place in the main working
 * tree; a linked worktree has its own `--git-dir` under `.git/worktrees/<name>`
 * while `--git-common-dir` still points at the shared repo. Resolved to absolute
 * paths before comparing since git may print either relative or absolute output
 * depending on platform/version. Returns `false` (never throws) when `cwd` isn't
 * a git repo at all.
 */
export function isLinkedWorktree(cwd: string = process.cwd()): boolean {
  const gitDir = run(`git rev-parse --git-dir`, cwd);
  const gitCommonDir = run(`git rev-parse --git-common-dir`, cwd);
  if (gitDir === undefined || gitCommonDir === undefined) return false;
  return path.resolve(cwd, gitDir) !== path.resolve(cwd, gitCommonDir);
}

/**
 * Absolute path of the repository root containing `dir`, or null when `dir`
 * is not inside a work tree.
 *
 * Runs `git -C <dir>` so the answer describes the plan file's repo, not the
 * server process's cwd. The result is normalized, so two spellings of the same
 * root (`B:\repo` vs `b:/repo`) produce one identity (B-10).
 */
export function resolveRepoRoot(dir: string): string | null {
  try {
    const out = execSync('git rev-parse --show-toplevel', {
      cwd: dir,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: 'pipe',
    }).trim();
    return out ? normalizePath(out) : null;
  } catch {
    return null;
  }
}

/**
 * Whether `absPath` is tracked by the git repo containing it.
 *
 * Used to pick the revision-1 diff baseline: a tracked plan diffs against
 * `HEAD:<relpath>`, an untracked one renders as all-added (B-5).
 */
export function isTracked(repoRoot: string, absPath: string): boolean {
  try {
    execSync(`git ls-files --error-unmatch -- "${toRepoRelative(repoRoot, absPath)}"`, {
      cwd: repoRoot,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Content of `absPath` at git HEAD, or null when the path is untracked, the
 * repo has no commits yet, or git is unavailable.
 *
 * Returned as a raw utf-8 string with line endings untouched — normalizing CRLF
 * here would shift every anchor in the diff (B-11).
 */
export function readHeadContent(repoRoot: string, absPath: string): string | null {
  try {
    const relative = toRepoRelative(repoRoot, absPath);
    return execSync(`git show "HEAD:${relative}"`, {
      cwd: repoRoot,
      timeout: 5000,
      stdio: 'pipe',
      maxBuffer: 64 * 1024 * 1024,
    }).toString('utf8');
  } catch {
    return null;
  }
}

/** Forward-slashed, repo-root-relative form of `absPath` — git's own spelling. */
export function toRepoRelative(repoRoot: string, absPath: string): string {
  return path.relative(repoRoot, absPath).split(path.sep).join('/');
}

/**
 * Canonical spelling of a path for hashing and comparison.
 *
 * Windows paths are case-insensitive and accept either separator, so `B:\a\b`
 * and `b:/a/b` name the same file and must hash to one identity (B-10). Only
 * the drive letter is case-folded — the rest of the path keeps its case, since
 * the store is also read on case-sensitive filesystems.
 */
export function normalizePath(p: string): string {
  const slashed = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return slashed.replace(/^([a-zA-Z]):/, (_m, drive: string) => `${drive.toUpperCase()}:`);
}
