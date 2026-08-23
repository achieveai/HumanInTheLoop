import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { execSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  resolveSenderIdentity,
  defaultSessionNameResolver,
  makeSessionNameResolver,
  resolveProjectKey,
} from '../identity.js';
import type { SessionNameResolver } from '../identity.js';

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
  const originalProjectDir = process.env.CLAUDE_PROJECT_DIR;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'hitl-identity-'));
    // Composition prefers CLAUDE_PROJECT_DIR when set (§5.4); tests below
    // assert against the passed-in cwd, so the ambient environment (this
    // suite may itself be running inside a Claude Code session) must not leak in.
    delete process.env.CLAUDE_PROJECT_DIR;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (originalProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = originalProjectDir;
  });

  it('uses the session tier (composed label) when the resolver returns non-null, regardless of cwd', () => {
    // Precedence, not verbatim passthrough: source stays 'session' — never
    // falling through to worktree/path detection — for both a worktree cwd
    // and a plain-repo cwd. The label itself is composed per spec §5.4
    // (repo · branch · id-prefix), same as every other tier composes rather
    // than echoing a raw input.
    const repoDir = path.join(root, 'repo');
    initRepo(repoDir);
    execSync('git commit --allow-empty -q -m init', { cwd: repoDir, stdio: 'pipe' });
    const worktreeDir = path.join(root, 'linked-worktree');
    execSync(`git worktree add -q -b feature/side "${worktreeDir}"`, { cwd: repoDir, stdio: 'pipe' });

    const sessionResolver = () => 'my-session-name';

    const fromWorktree = resolveSenderIdentity(worktreeDir, 'Kay9', sessionResolver);
    expect(fromWorktree.source).toBe('session');
    expect(fromWorktree.label).toBe(`${path.basename(worktreeDir)} · feature/side · my-s`);

    // `root` itself isn't a git repo, so the label falls back to the
    // path-tier heuristic (last two segments) plus the id prefix.
    const fromNonRepo = resolveSenderIdentity(root, 'Kay9', sessionResolver);
    expect(fromNonRepo.source).toBe('session');
    expect(fromNonRepo.label).toBe(`${path.basename(path.dirname(root))}/${path.basename(root)} · my-s`);
  });

  // The default sessionResolver is no longer a dead stub (that was the whole
  // point of this task) — it always resolves to a minted uuid. The tests
  // below exist specifically to exercise the worktree/path tiers, so they
  // must opt out of the (now-live) session tier explicitly with `() => null`.
  const noSession: SessionNameResolver = () => null;

  it('uses the worktree tier for a linked worktree: "<device> - <branch>"', () => {
    const repoDir = path.join(root, 'repo');
    initRepo(repoDir);
    execSync('git commit --allow-empty -q -m init', { cwd: repoDir, stdio: 'pipe' });
    const worktreeDir = path.join(root, 'linked-worktree');
    execSync(`git worktree add -q -b work-item/1-reviewplan "${worktreeDir}"`, { cwd: repoDir, stdio: 'pipe' });

    expect(resolveSenderIdentity(worktreeDir, 'Kay9', noSession)).toEqual({
      label: 'Kay9 - work-item/1-reviewplan',
      source: 'worktree',
    });
  });

  it('falls back to the path tier for a non-worktree git repo (main working tree)', () => {
    const repoDir = path.join(root, 'plain-repo');
    initRepo(repoDir);

    const result = resolveSenderIdentity(repoDir, 'Kay9', noSession);
    expect(result.source).toBe('path');
    expect(result.label).toContain('Kay9');
  });

  it('falls back to the path tier for a non-git directory', () => {
    const plainDir = path.join(root, 'not-a-repo');
    mkdirSync(plainDir, { recursive: true });

    const result = resolveSenderIdentity(plainDir, 'Kay9', noSession);
    expect(result.source).toBe('path');
    // Last two path segments: the temp-dir's own random name, then 'not-a-repo'.
    expect(result.label).toBe(`Kay9 ${path.basename(root)}/not-a-repo`);
  });

  it('path-fallback label joins the last two segments with "/", never an absolute path, and normalizes separators', () => {
    const cwd = path.join(root, 'workspace', 'hitl-mcp-server', 'server');

    const result = resolveSenderIdentity(cwd, 'Kay9', noSession);

    expect(result.source).toBe('path');
    expect(result.label).toBe('Kay9 hitl-mcp-server/server');
    if (path.sep !== '/') {
      expect(result.label).not.toContain(path.sep);
    }
    expect(result.label).not.toContain(root);
  });

  it('produces a valid, non-crashing label when cwd has only one path segment', () => {
    const cwd = 'onlysegment';

    expect(() => resolveSenderIdentity(cwd, 'Kay9', noSession)).not.toThrow();
    const result = resolveSenderIdentity(cwd, 'Kay9', noSession);
    expect(result.source).toBe('path');
    expect(result.label).toBe('Kay9 onlysegment');
  });

  it('defaultSessionNameResolver mints a stable, non-null id for the process lifetime', () => {
    // No longer the dead stub — it now populates the 'session' tier by
    // default. Value is opaque here (env-dependent, see makeSessionNameResolver
    // tests for the precedence logic); this only pins "non-null and stable".
    const first = defaultSessionNameResolver();
    const second = defaultSessionNameResolver();
    expect(first).not.toBeNull();
    expect(first).toBe(second);
  });

  it('composes the session-tier label with a directory that is not a git repo, using the last-two-segments fallback', () => {
    const cwd = path.join(root, 'workspace', 'not-a-repo');
    mkdirSync(cwd, { recursive: true });

    const result = resolveSenderIdentity(cwd, 'Kay9', () => 'abcdef123456');

    expect(result.source).toBe('session');
    expect(result.label).toBe('workspace/not-a-repo · abcd');
  });

  it('composes the session-tier label from CLAUDE_PROJECT_DIR when set, in preference to cwd', () => {
    const repoDir = path.join(root, 'proj-repo');
    initRepo(repoDir);
    execSync('git checkout -q -b main', { cwd: repoDir, stdio: 'pipe' });
    execSync('git commit --allow-empty -q -m init', { cwd: repoDir, stdio: 'pipe' });
    process.env.CLAUDE_PROJECT_DIR = repoDir;

    const unrelatedCwd = path.join(root, 'unrelated-non-repo-dir');
    mkdirSync(unrelatedCwd, { recursive: true });

    const result = resolveSenderIdentity(unrelatedCwd, 'Kay9', () => 'abcdef123456');

    expect(result.source).toBe('session');
    expect(result.label).toBe(`${path.basename(repoDir)} · main · abcd`);
  });
});

describe('session identity', () => {
  it('prefers the bridge session id when Claude Code provides one', () => {
    const resolver = makeSessionNameResolver({
      env: { CLAUDE_CODE_BRIDGE_SESSION_ID: 'session_abc123' },
      mintedUuid: 'uuid-fallback',
    });
    expect(resolver()).toBe('session_abc123');
  });

  it('falls back to the process-minted uuid when no env var is set', () => {
    const resolver = makeSessionNameResolver({ env: {}, mintedUuid: 'uuid-fallback' });
    expect(resolver()).toBe('uuid-fallback');
  });

  it('returns the same value on every call within a process', () => {
    const resolver = makeSessionNameResolver({ env: {}, mintedUuid: 'stable-uuid' });
    expect(resolver()).toBe(resolver());
  });

  it('stays stable even if the bridge id disappears mid-process (Remote Control ending)', () => {
    const env: NodeJS.ProcessEnv = { CLAUDE_CODE_BRIDGE_SESSION_ID: 'session_abc123' };
    const resolver = makeSessionNameResolver({ env, mintedUuid: 'uuid-fallback' });
    expect(resolver()).toBe('session_abc123');
    delete env.CLAUDE_CODE_BRIDGE_SESSION_ID;
    expect(resolver()).toBe('session_abc123');
  });

  it('resolves identity at the session tier, outranking worktree and path', () => {
    const identity = resolveSenderIdentity('/repo/path', 'Kay9', () => 'session_abc123');
    expect(identity.source).toBe('session');
  });

  it('still falls back to worktree or path when the resolver yields null', () => {
    const identity = resolveSenderIdentity('/repo/path', 'Kay9', () => null);
    expect(identity.source).not.toBe('session');
  });

  it('gives two different bridge sessions two different label suffixes', () => {
    // Every real bridge id is shaped `session_<opaque>`, so slicing the first
    // four characters off the raw id produced the literal `sess` for every
    // session on every machine — the suffix existed to tell concurrent sessions
    // apart and told you nothing. Two ids differing only after the prefix must
    // land on different labels.
    const a = resolveSenderIdentity('/repo/path', 'Kay9', () => 'session_01MDRkE3taa2');
    const b = resolveSenderIdentity('/repo/path', 'Kay9', () => 'session_ZZ9QfG7xyw41');

    expect(a.label).toBe('repo/path · 01MD');
    expect(b.label).toBe('repo/path · ZZ9Q');
    expect(a.label).not.toBe(b.label);
  });

  it('leaves a minted uuid’s suffix exactly as it was', () => {
    // The prefix strip must be a no-op for ids that never carried one.
    const identity = resolveSenderIdentity('/repo/path', 'Kay9', () => 'abcdef123456');
    expect(identity.label).toBe('repo/path · abcd');
  });
});

describe('resolveProjectKey', () => {
  const originalProjectDir = process.env.CLAUDE_PROJECT_DIR;

  afterEach(() => {
    if (originalProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = originalProjectDir;
  });

  it('prefers CLAUDE_PROJECT_DIR when set', () => {
    process.env.CLAUDE_PROJECT_DIR = '/documented/stable/dir';
    const repo = { name: 'x', branch: 'y', remoteUrl: 'https://example.com/repo.git' };
    expect(resolveProjectKey('/some/cwd', repo)).toBe('/documented/stable/dir');
  });

  it('falls back to repo.remoteUrl when CLAUDE_PROJECT_DIR is unset', () => {
    delete process.env.CLAUDE_PROJECT_DIR;
    const repo = { name: 'x', branch: 'y', remoteUrl: 'https://example.com/repo.git' };
    expect(resolveProjectKey('/some/cwd', repo)).toBe('https://example.com/repo.git');
  });

  it('falls back to cwd when neither CLAUDE_PROJECT_DIR nor a remote url is available', () => {
    delete process.env.CLAUDE_PROJECT_DIR;
    expect(resolveProjectKey('/some/cwd', null)).toBe('/some/cwd');
  });
});
