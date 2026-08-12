import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { readPlanFile, PlanFileError, PLAN_MAX_BYTES } from '../plan-file.js';

/**
 * F-1..F-4. The ordering matters as much as the individual checks: every
 * rejection here must happen BEFORE the file is read, and the extension check
 * must run on the resolved realpath rather than on the name the agent passed.
 */
describe('readPlanFile', () => {
  let dir: string;
  let symlinksSupported = true;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'hitl-plan-file-'));

    writeFileSync(path.join(dir, 'plan.md'), '# Plan\n\nline two\n', 'utf8');
    writeFileSync(path.join(dir, 'notes.txt'), 'not markdown\n', 'utf8');
    writeFileSync(path.join(dir, 'plan.markdown'), '# Also a plan\n', 'utf8');
    mkdirSync(path.join(dir, 'plans.md'));

    // A .md name pointing at a non-markdown file — the F-2 case.
    try {
      symlinkSync(path.join(dir, 'notes.txt'), path.join(dir, 'sneaky.md'));
    } catch {
      // Windows needs developer mode or elevation for symlinks.
      symlinksSupported = false;
    }
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads a .md file and preserves its bytes verbatim', () => {
    const plan = readPlanFile(path.join(dir, 'plan.md'));

    expect(plan.content).toBe('# Plan\n\nline two\n');
    expect(plan.byteLength).toBe(Buffer.byteLength('# Plan\n\nline two\n', 'utf8'));
    expect(path.extname(plan.resolvedPath)).toBe('.md');
  });

  it('accepts .markdown as well', () => {
    expect(readPlanFile(path.join(dir, 'plan.markdown')).content).toBe('# Also a plan\n');
  });

  it('resolves a cwd-relative path against the supplied cwd', () => {
    expect(readPlanFile('plan.md', dir).content).toBe('# Plan\n\nline two\n');
  });

  it('rejects a non-markdown extension', () => {
    expect(() => readPlanFile(path.join(dir, 'notes.txt'))).toThrow(PlanFileError);
    expect(() => readPlanFile(path.join(dir, 'notes.txt'))).toThrow(/must be markdown/);
  });

  it('rejects a .md symlink whose target is not markdown (F-2)', () => {
    if (!symlinksSupported) {
      // Documented rather than silently skipped: the check is exercised on any
      // platform where the test process may create symlinks.
      expect(symlinksSupported).toBe(false);
      return;
    }
    expect(() => readPlanFile(path.join(dir, 'sneaky.md'))).toThrow(/must be markdown/);
  });

  it('rejects a directory even when it is named like markdown (F-3)', () => {
    expect(() => readPlanFile(path.join(dir, 'plans.md'))).toThrow(/is a directory/);
  });

  it('rejects a path containing NUL before touching the filesystem (F-3)', () => {
    expect(() => readPlanFile(path.join(dir, 'plan.md') + '\0.txt')).toThrow(/NUL byte/);
  });

  it('rejects an empty filePath', () => {
    expect(() => readPlanFile('   ')).toThrow(/non-empty string/);
  });

  it('reports a missing file distinctly from an invalid one', () => {
    expect(() => readPlanFile(path.join(dir, 'nope.md'))).toThrow(/not found/);
  });

  it('hard-rejects one byte over the size cap rather than truncating (F-4)', () => {
    const big = path.join(dir, 'big.md');
    writeFileSync(big, 'x'.repeat(1001), 'utf8');

    expect(() => readPlanFile(big, dir, 1000)).toThrow(/over the 1000-byte limit/);
    // Exactly at the cap is fine.
    expect(readPlanFile(big, dir, 1001).byteLength).toBe(1001);
  });

  it('defaults the cap to 1 MB', () => {
    expect(PLAN_MAX_BYTES).toBe(1024 * 1024);
  });
});
