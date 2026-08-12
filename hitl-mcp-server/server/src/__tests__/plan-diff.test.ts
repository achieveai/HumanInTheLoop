import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { execSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { buildPlanDiff, resolveBaseline, splitLinesPreserving } from '../plan-diff.js';
import { resolvePlanIdentity, recordRevision } from '../snapshot-store.js';

/** Anchor positions as the review pane sees them: 1-indexed `@@` hunk lines. */
function hunkLines(patch: string): string[] {
  const start = patch.split('\n').findIndex((l) => l.startsWith('@@'));
  return patch.split('\n').slice(start + 1);
}

function hunkHeader(patch: string): string {
  return patch.split('\n').find((l) => l.startsWith('@@')) ?? '';
}

describe('buildPlanDiff', () => {
  it('renders a brand-new plan as one all-added hunk (B-1)', () => {
    const patch = buildPlanDiff('docs/plan.md', 'one\ntwo\nthree\n', null);

    expect(patch).toContain('--- a/docs/plan.md');
    expect(patch).toContain('+++ b/docs/plan.md');
    expect(hunkHeader(patch)).toBe('@@ -0,0 +1,3 @@');
    expect(hunkLines(patch).slice(0, 3)).toEqual(['+one', '+two', '+three']);
  });

  it('renders a byte-identical resubmit as a non-empty all-context hunk (B-3)', () => {
    const content = 'alpha\nbeta\ngamma\n';
    const patch = buildPlanDiff('plan.md', content, content);

    expect(hunkHeader(patch)).toBe('@@ -1,3 +1,3 @@');
    expect(hunkLines(patch).slice(0, 3)).toEqual([' alpha', ' beta', ' gamma']);
    // Every line is present, so every line stays selectable.
    expect(hunkLines(patch).filter((l) => l.startsWith('+') || l.startsWith('-'))).toEqual([]);
  });

  it('shows the whole document as context around a single changed line (B-2)', () => {
    const before = 'a\nb\nc\nd\ne\n';
    const after = 'a\nb\nCHANGED\nd\ne\n';
    const patch = buildPlanDiff('plan.md', after, before);

    const lines = hunkLines(patch);
    expect(lines).toContain(' a');
    expect(lines).toContain(' e');
    expect(lines).toContain('-c');
    expect(lines).toContain('+CHANGED');
    // One hunk, not several — full context means the diff is the whole plan.
    expect(patch.split('\n').filter((l) => l.startsWith('@@'))).toHaveLength(1);
  });

  it('gives a CRLF plan the same anchors as its LF twin, bytes untouched (B-11)', () => {
    const lf = 'first\nsecond\nthird\n';
    const crlf = 'first\r\nsecond\r\nthird\r\n';

    const lfPatch = buildPlanDiff('plan.md', lf, null);
    const crlfPatch = buildPlanDiff('plan.md', crlf, null);

    expect(hunkHeader(crlfPatch)).toBe(hunkHeader(lfPatch));
    // Same line count, same 1-indexed positions.
    expect(hunkLines(crlfPatch).slice(0, 3).map((l) => l.replace(/\r$/, ''))).toEqual([
      '+first',
      '+second',
      '+third',
    ]);
    // The CR survives verbatim rather than being normalized away.
    expect(hunkLines(crlfPatch)[0]).toBe('+first\r');
  });

  it('keeps CRLF anchors aligned when only one line changes', () => {
    const before = 'a\r\nb\r\nc\r\n';
    const after = 'a\r\nB\r\nc\r\n';
    const lines = hunkLines(buildPlanDiff('plan.md', after, before));

    expect(lines).toContain('-b\r');
    expect(lines).toContain('+B\r');
    expect(lines).toContain(' a\r');
  });

  it('marks a missing trailing newline rather than inventing one', () => {
    const patch = buildPlanDiff('plan.md', 'one\ntwo', null);

    expect(hunkHeader(patch)).toBe('@@ -0,0 +1,2 @@');
    expect(hunkLines(patch).slice(0, 3)).toEqual(['+one', '+two', '\\ No newline at end of file']);
  });

  it('marks a missing trailing newline on an unchanged resubmit too', () => {
    const content = 'only line';
    const patch = buildPlanDiff('plan.md', content, content);

    expect(hunkLines(patch).slice(0, 2)).toEqual([' only line', '\\ No newline at end of file']);
  });

  it('handles an empty plan without producing a hunkless patch', () => {
    const patch = buildPlanDiff('plan.md', '', null);

    expect(patch).toContain('@@');
    expect(hunkHeader(patch)).toBe('@@ -0,0 +0,0 @@');
  });
});

describe('splitLinesPreserving', () => {
  it('leaves CR attached to its own line', () => {
    expect(splitLinesPreserving('a\r\nb\r\n')).toEqual({
      lines: ['a\r', 'b\r'],
      hasTrailingNewline: true,
    });
  });

  it('reports a missing final newline', () => {
    expect(splitLinesPreserving('a\nb')).toEqual({ lines: ['a', 'b'], hasTrailingNewline: false });
  });

  it('treats an empty document as zero lines', () => {
    expect(splitLinesPreserving('')).toEqual({ lines: [], hasTrailingNewline: true });
  });
});

describe('resolveBaseline', () => {
  let home: string;
  let work: string;
  const originalHome = process.env.HITL_HOME;

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

  const initRepo = (dir: string) => {
    mkdirSync(dir, { recursive: true });
    const opts = { cwd: dir, stdio: 'pipe' as const };
    execSync('git init -q', opts);
    execSync('git config user.email test@example.com', opts);
    execSync('git config user.name Test', opts);
  };

  it('diffs revision 1 of a tracked plan against git HEAD (B-5)', () => {
    const repo = path.join(work, 'repo');
    initRepo(repo);
    const file = path.join(repo, 'plan.md');
    writeFileSync(file, 'committed\n', 'utf8');
    execSync('git add plan.md && git commit -q -m init', { cwd: repo, stdio: 'pipe' });
    writeFileSync(file, 'committed\nplus a new line\n', 'utf8');

    const identity = resolvePlanIdentity(realpathSync.native(file));
    const recorded = recordRevision(identity, 'committed\nplus a new line\n');

    expect(resolveBaseline(identity, recorded)).toBe('committed\n');
  });

  it('renders revision 1 of an untracked plan as all-added (B-5)', () => {
    const repo = path.join(work, 'repo');
    initRepo(repo);
    writeFileSync(path.join(repo, '.gitignore'), 'plans/\n', 'utf8');
    mkdirSync(path.join(repo, 'plans'));
    const file = path.join(repo, 'plans', 'plan.md');
    writeFileSync(file, 'ignored plan\n', 'utf8');

    const identity = resolvePlanIdentity(realpathSync.native(file));
    const recorded = recordRevision(identity, 'ignored plan\n');

    expect(resolveBaseline(identity, recorded)).toBeNull();
  });

  it('diffs revision 2+ against the previous snapshot, ignoring git', () => {
    const repo = path.join(work, 'repo');
    initRepo(repo);
    const file = path.join(repo, 'plan.md');
    writeFileSync(file, 'committed\n', 'utf8');
    execSync('git add plan.md && git commit -q -m init', { cwd: repo, stdio: 'pipe' });

    const identity = resolvePlanIdentity(realpathSync.native(file));
    recordRevision(identity, 'snapshot one\n');
    const second = recordRevision(identity, 'snapshot two\n');

    expect(second.revision).toBe(2);
    expect(resolveBaseline(identity, second)).toBe('snapshot one\n');
  });

  it('falls back to all-added when a previous object has gone missing', () => {
    const identity = resolvePlanIdentity(realpathSync.native(planOutsideRepo()));
    recordRevision(identity, 'v1\n');
    rmSync(path.join(identity.dir, 'objects'), { recursive: true, force: true });
    const second = recordRevision(identity, 'v2\n');

    expect(resolveBaseline(identity, second)).toBeNull();
  });

  function planOutsideRepo(): string {
    const file = path.join(work, 'loose-plan.md');
    writeFileSync(file, 'loose\n', 'utf8');
    return file;
  }
});
