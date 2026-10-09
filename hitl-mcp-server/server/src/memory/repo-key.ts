import { execFileSync } from 'child_process';
import { normalizePath } from '../git-context.js';

/** A repo as memory sync sees it: one key shared by every clone, worktree and machine. */
export interface RepoIdentity {
  /** Stable key, e.g. `github.com/achieveai/humanintheloop`, or `root/<sha>` with no origin. */
  key: string;
  /** Normalized root of the work tree the session is in. */
  root: string;
}

/**
 * The origin URL reduced to `host/path`, so every spelling of one remote gives
 * one key: ssh and https, a user in the URL, `.git` or not, any case.
 *
 * Azure DevOps has three spellings of one repo (`dev.azure.com/org/p/_git/r`,
 * `org.visualstudio.com/p/_git/r`, `ssh.dev.azure.com:v3/org/p/r`); all map to
 * `dev.azure.com/org/p/r`. A local-path origin is not a shared identity, so it
 * returns null and the caller falls back to the root commit.
 */
export function repoKeyFromOrigin(url: string): string | null {
  let rest = url.trim().toLowerCase();
  if (!rest || rest.startsWith('file:') || /^[a-z]:[\\/]/.test(rest) || rest.startsWith('/') || rest.startsWith('.')) {
    return null;
  }
  // scp-like ssh: user@host:path
  const scp = /^[^/@]+@([^/:]+):(.+)$/.exec(rest);
  if (scp && !rest.includes('://')) {
    rest = `${scp[1]}/${scp[2]}`;
  } else {
    rest = rest.replace(/^[a-z+]+:\/\//, '').replace(/^[^/@]+@/, '').replace(/^([^/:]+):\d+\//, '$1/');
  }
  rest = rest.replace(/\.git$/, '').replace(/\/+$/, '').replace(/\/{2,}/g, '/');

  const vs = /^([^./]+)\.visualstudio\.com\/(?:defaultcollection\/)?(.+)$/.exec(rest);
  if (vs) rest = `dev.azure.com/${vs[1]}/${vs[2]}`;
  const sshAdo = /^ssh\.dev\.azure\.com\/v3\/(.+)$/.exec(rest);
  if (sshAdo) rest = `dev.azure.com/${sshAdo[1]}`;
  if (rest.startsWith('dev.azure.com/')) rest = rest.replace('/_git/', '/');

  return /^[a-z0-9.-]+\/.+/.test(rest) && !rest.split('/').includes('..') ? rest : null;
}

function git(args: string[], cwd: string): string | undefined {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: 5000, stdio: 'pipe' }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The repo `cwd` is in, or null outside git: no repo, no sync. */
export function resolveRepo(cwd: string): RepoIdentity | null {
  const root = git(['rev-parse', '--show-toplevel'], cwd);
  if (!root) return null;
  const origin = git(['remote', 'get-url', 'origin'], cwd);
  const fromOrigin = origin ? repoKeyFromOrigin(origin) : null;
  if (fromOrigin) return { key: fromOrigin, root: normalizePath(root) };
  // No usable origin: the first root commit is the same in every clone.
  const rootCommit = git(['rev-list', '--max-parents=0', 'HEAD'], cwd)?.split(/\s+/).sort()[0];
  return rootCommit ? { key: `root/${rootCommit}`, root: normalizePath(root) } : null;
}
