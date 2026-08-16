import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { execSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { resolveSenderIdentity, defaultSessionNameResolver } from '../identity.js';

/** Init a throwaway git repo with committer identity set, matching this repo's test convention. */
function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const opts = { cwd: dir, stdio: 'pipe' as const };
  execSync('git init -q', opts);
  execSync('git config user.email test@example.com', opts);
  execSync('git config user.name Test', opts);
}

describe('resolveSenderIdentity', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'hitl-identity-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('uses the session resolver verbatim when it returns non-null, regardless of cwd', () => {
    const repoDir = path.join(root, 'repo');
    initRepo(repoDir);
    execSync('git commit --allow-empty -q -m init', { cwd: repoDir, stdio: 'pipe' });
    const worktreeDir = path.join(root, 'linked-worktree');
    execSync(`git worktree add -q -b feature/side "${worktreeDir}"`, { cwd: repoDir, stdio: 'pipe' });

    const sessionResolver = () => 'my-session-name';

    expect(resolveSenderIdentity(worktreeDir, 'Kay9', sessionResolver)).toEqual({
      label: 'my-session-name',
      source: 'session',
    });
    expect(resolveSenderIdentity(root, 'Kay9', sessionResolver)).toEqual({
      label: 'my-session-name',
      source: 'session',
    });
  });

  it('uses the worktree tier for a linked worktree: "<device> - <branch>"', () => {
    const repoDir = path.join(root, 'repo');
    initRepo(repoDir);
    execSync('git commit --allow-empty -q -m init', { cwd: repoDir, stdio: 'pipe' });
    const worktreeDir = path.join(root, 'linked-worktree');
    execSync(`git worktree add -q -b work-item/1-reviewplan "${worktreeDir}"`, { cwd: repoDir, stdio: 'pipe' });

    expect(resolveSenderIdentity(worktreeDir, 'Kay9')).toEqual({
      label: 'Kay9 - work-item/1-reviewplan',
      source: 'worktree',
    });
  });

  it('falls back to the path tier for a non-worktree git repo (main working tree)', () => {
    const repoDir = path.join(root, 'plain-repo');
    initRepo(repoDir);

    const result = resolveSenderIdentity(repoDir, 'Kay9');
    expect(result.source).toBe('path');
    expect(result.label).toContain('Kay9');
  });

  it('falls back to the path tier for a non-git directory', () => {
    const plainDir = path.join(root, 'not-a-repo');
    mkdirSync(plainDir, { recursive: true });

    const result = resolveSenderIdentity(plainDir, 'Kay9');
    expect(result.source).toBe('path');
    // Last two path segments: the temp-dir's own random name, then 'not-a-repo'.
    expect(result.label).toBe(`Kay9 ${path.basename(root)}/not-a-repo`);
  });

  it('path-fallback label joins the last two segments with "/", never an absolute path, and normalizes separators', () => {
    const cwd = path.join(root, 'workspace', 'hitl-mcp-server', 'server');

    const result = resolveSenderIdentity(cwd, 'Kay9');

    expect(result.source).toBe('path');
    expect(result.label).toBe('Kay9 hitl-mcp-server/server');
    if (path.sep !== '/') {
      expect(result.label).not.toContain(path.sep);
    }
    expect(result.label).not.toContain(root);
  });

  it('produces a valid, non-crashing label when cwd has only one path segment', () => {
    const cwd = 'onlysegment';

    expect(() => resolveSenderIdentity(cwd, 'Kay9')).not.toThrow();
    const result = resolveSenderIdentity(cwd, 'Kay9');
    expect(result.source).toBe('path');
    expect(result.label).toBe('Kay9 onlysegment');
  });

  it('defaultSessionNameResolver always returns null', () => {
    expect(defaultSessionNameResolver()).toBeNull();
  });
});
