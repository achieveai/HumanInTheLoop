import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { execSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { isLinkedWorktree } from '../git-context.js';

/** Init a throwaway git repo with committer identity set, matching this repo's test convention. */
function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const opts = { cwd: dir, stdio: 'pipe' as const };
  execSync('git init -q', opts);
  execSync('git config user.email test@example.com', opts);
  execSync('git config user.name Test', opts);
}

describe('isLinkedWorktree', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'hitl-worktree-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('is false in the main working tree', () => {
    const repoDir = path.join(root, 'main-repo');
    initRepo(repoDir);

    expect(isLinkedWorktree(repoDir)).toBe(false);
  });

  it('is true inside a linked worktree created via `git worktree add`', () => {
    const repoDir = path.join(root, 'repo');
    initRepo(repoDir);
    // A worktree needs a real commit to branch off of.
    execSync('git commit --allow-empty -q -m init', { cwd: repoDir, stdio: 'pipe' });

    const worktreeDir = path.join(root, 'linked-worktree');
    execSync(`git worktree add -q -b feature/side "${worktreeDir}"`, { cwd: repoDir, stdio: 'pipe' });

    expect(isLinkedWorktree(worktreeDir)).toBe(true);
    // The originating repo itself is still the main working tree.
    expect(isLinkedWorktree(repoDir)).toBe(false);
  });

  it('tolerates a non-git directory, returning false without throwing', () => {
    const plainDir = path.join(root, 'not-a-repo');
    mkdirSync(plainDir, { recursive: true });

    expect(() => isLinkedWorktree(plainDir)).not.toThrow();
    expect(isLinkedWorktree(plainDir)).toBe(false);
  });

  it('defaults to process.cwd() when no cwd argument is given', () => {
    const repoDir = path.join(root, 'default-cwd-repo');
    initRepo(repoDir);

    const originalCwd = process.cwd();
    process.chdir(repoDir);
    try {
      expect(isLinkedWorktree()).toBe(false);
    } finally {
      process.chdir(originalCwd);
    }
  });
});
