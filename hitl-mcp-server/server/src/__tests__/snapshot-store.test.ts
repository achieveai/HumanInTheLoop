import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { execSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  resolvePlanIdentity,
  recordRevision,
  readLatest,
  readObject,
  parseLatest,
  getPlansRoot,
} from '../snapshot-store.js';
import { normalizePath } from '../git-context.js';

/**
 * B-1..B-3, B-7, B-9, B-10. The store is deliberately lock-free, so these
 * assertions cover the properties that replace a lock: content addressing,
 * atomic pointer replacement, and identity that cannot collide across repos.
 */
describe('snapshot store', () => {
  let home: string;
  let work: string;
  const originalHome = process.env.HITL_HOME;

  const gitInit = (dir: string) => {
    const opts = { cwd: dir, stdio: 'pipe' as const };
    execSync('git init -q', opts);
    execSync('git config user.email test@example.com', opts);
    execSync('git config user.name Test', opts);
  };

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'hitl-home-'));
    work = mkdtempSync(path.join(tmpdir(), 'hitl-work-'));
    process.env.HITL_HOME = home;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HITL_HOME;
    else process.env.HITL_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  });

  const planAt = (dir: string, name = 'plan.md', body = '# Plan\n') => {
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    writeFileSync(file, body, 'utf8');
    return realpathSync.native(file);
  };

  it('advances revisions 1 → 2 → 3 and keeps every object', () => {
    const file = planAt(work);
    const identity = resolvePlanIdentity(file);

    const r1 = recordRevision(identity, 'v1\n');
    expect(r1.revision).toBe(1);
    expect(r1.isNewPlan).toBe(true);
    expect(r1.previous).toBeNull();
    expect(r1.previousContent).toBeNull();

    const r2 = recordRevision(identity, 'v2\n');
    expect(r2.revision).toBe(2);
    expect(r2.isNewPlan).toBe(false);
    expect(r2.previousContent).toBe('v1\n');

    const r3 = recordRevision(identity, 'v3\n');
    expect(r3.revision).toBe(3);
    expect(r3.previousContent).toBe('v2\n');

    expect(readObject(identity, r1.digest)).toBe('v1\n');
    expect(readObject(identity, r2.digest)).toBe('v2\n');
    expect(readLatest(identity)?.revision).toBe(3);
  });

  it('advances the revision on a byte-identical resubmit (B-3)', () => {
    const identity = resolvePlanIdentity(planAt(work));

    recordRevision(identity, 'same\n');
    const again = recordRevision(identity, 'same\n');

    expect(again.revision).toBe(2);
    expect(again.isNewPlan).toBe(false);
    expect(again.previousContent).toBe('same\n');
    expect(again.digest).toBe(readLatest(identity)?.digest);
  });

  it('gives the same relative path in two repos distinct identities (B-7)', () => {
    const repoA = path.join(work, 'repo-a');
    const repoB = path.join(work, 'repo-b');
    mkdirSync(path.join(repoA, 'docs'), { recursive: true });
    mkdirSync(path.join(repoB, 'docs'), { recursive: true });
    gitInit(repoA);
    gitInit(repoB);

    const a = resolvePlanIdentity(planAt(path.join(repoA, 'docs')));
    const b = resolvePlanIdentity(planAt(path.join(repoB, 'docs')));

    expect(a.displayPath).toBe('docs/plan.md');
    expect(b.displayPath).toBe('docs/plan.md');
    expect(a.planId).not.toBe(b.planId);
    expect(a.dir).not.toBe(b.dir);
  });

  it('resolves git from the plan directory, not process.cwd() (B-6)', () => {
    const repo = path.join(work, 'sibling');
    mkdirSync(repo, { recursive: true });
    gitInit(repo);

    const identity = resolvePlanIdentity(planAt(repo));

    expect(identity.repoRoot).toBe(normalizePath(realpathSync.native(repo)));
    expect(identity.displayPath).toBe('plan.md');
    expect(path.isAbsolute(identity.displayPath)).toBe(false);
  });

  it('falls back to the containing directory outside a repo, showing only the basename (F-9)', () => {
    const identity = resolvePlanIdentity(planAt(work, 'secret-plan.md'));

    expect(identity.repoRoot).toBeNull();
    expect(identity.displayPath).toBe('secret-plan.md');
  });

  it('collapses Windows drive-letter casing and separators to one identity (B-10)', () => {
    const file = planAt(work);

    expect(normalizePath('B:\\a\\b')).toBe('B:/a/b');
    expect(normalizePath('b:/a/b')).toBe('B:/a/b');
    expect(normalizePath('b:\\a\\b\\')).toBe('B:/a/b');

    // The same file spelled with the opposite separator style hashes identically.
    const spelledWithBackslashes = file.split('/').join(path.sep);
    expect(resolvePlanIdentity(spelledWithBackslashes).planId).toBe(resolvePlanIdentity(file).planId);
  });

  it('leaves the previous latest.json byte-identical when a write fails (B-9)', () => {
    const identity = resolvePlanIdentity(planAt(work));
    recordRevision(identity, 'good\n');

    const latestFile = path.join(identity.dir, 'latest.json');
    const before = readFileSync(latestFile, 'utf8');

    // A directory where the temp file must go makes writeFileSync fail mid-record.
    mkdirSync(`${latestFile}.tmp`, { recursive: true });
    expect(() => recordRevision(identity, 'next\n')).toThrow();
    rmSync(`${latestFile}.tmp`, { recursive: true, force: true });

    expect(readFileSync(latestFile, 'utf8')).toBe(before);
    expect(readLatest(identity)?.revision).toBe(1);
  });

  it('rejects a corrupt latest.json instead of trusting it', () => {
    const identity = resolvePlanIdentity(planAt(work));
    recordRevision(identity, 'good\n');
    const latestFile = path.join(identity.dir, 'latest.json');

    for (const bad of [
      'not json',
      JSON.stringify({ displayPath: 'plan.md', digest: 'ABCD', revision: 1, createdAt: 1 }),
      JSON.stringify({ displayPath: 'plan.md', digest: 'a'.repeat(64), revision: 0, createdAt: 1 }),
      JSON.stringify({ displayPath: 'plan.md', digest: 'a'.repeat(64), revision: 1, createdAt: 0 }),
      JSON.stringify({ displayPath: 'other.md', digest: 'a'.repeat(64), revision: 1, createdAt: 1 }),
    ]) {
      writeFileSync(latestFile, bad, 'utf8');
      expect(readLatest(identity)).toBeNull();
    }

    // An uppercase digest is not the 64 lowercase hex the contract requires.
    expect(
      parseLatest(
        JSON.stringify({ displayPath: 'plan.md', digest: 'A'.repeat(64), revision: 1, createdAt: 1 }),
        'plan.md'
      )
    ).toBeNull();

    // A rejected pointer degrades to "no history" — the next record starts over.
    expect(recordRevision(identity, 'fresh\n').revision).toBe(1);
  });

  it('roots the store under HITL_HOME so tests never touch a real home directory', () => {
    expect(getPlansRoot()).toBe(path.join(home, 'plans'));
    expect(resolvePlanIdentity(planAt(work)).dir.startsWith(path.join(home, 'plans'))).toBe(true);
  });
});
