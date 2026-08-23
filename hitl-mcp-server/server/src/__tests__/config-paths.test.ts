import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { saveConfig, getConfigPath, loadConfig, generateDefaultConfig } from '../config.js';

/**
 * Where config.json lives, against the real filesystem.
 *
 * The Rust side resolves config.json through `hitl_transport::paths::hitl_dir()`,
 * which honors HITL_HOME. This — the only code that ever *writes* that file, via
 * `hitl init` — used to hardcode `~/.hitl`. Under HITL_HOME the two languages
 * read and wrote different files, and every Rust binary then reported "Run
 * 'hitl init' to create one": advice that rewrites the same wrong path, forever,
 * with nothing naming the split. These tests pin the two back together.
 */
describe('config path resolution', () => {
  let root: string;
  const original = process.env.HITL_HOME;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'hitl-config-'));
  });

  afterEach(() => {
    if (original === undefined) delete process.env.HITL_HOME;
    else process.env.HITL_HOME = original;
    rmSync(root, { recursive: true, force: true });
  });

  it('writes and reads the same file under HITL_HOME', () => {
    process.env.HITL_HOME = root;
    const config = generateDefaultConfig();

    saveConfig(config);

    // The round trip is the whole point: whatever `hitl init` wrote is what a
    // reader resolving through the same rule must find.
    expect(getConfigPath()).toBe(path.join(root, 'config.json'));
    expect(JSON.parse(readFileSync(path.join(root, 'config.json'), 'utf-8')).topicId).toBe(
      config.topicId
    );
    expect(loadConfig().topicId).toBe(config.topicId);
  });

  it('follows HITL_HOME when it changes between calls', () => {
    // Resolved per call, not at import. A path frozen at module load is how the
    // Rust and TypeScript sides drifted apart in the first place, and it makes
    // the resolution untestable besides.
    process.env.HITL_HOME = root;
    const first = getConfigPath();

    const other = mkdtempSync(path.join(tmpdir(), 'hitl-config-'));
    try {
      process.env.HITL_HOME = other;
      expect(getConfigPath()).toBe(path.join(other, 'config.json'));
      expect(getConfigPath()).not.toBe(first);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('rejects an empty HITL_HOME rather than falling back to a relative path', () => {
    // `paths.rs` treats empty as an error for the same reason: joining onto ''
    // silently yields a path relative to the working directory, so the config
    // would follow whatever directory the process happened to start in.
    process.env.HITL_HOME = '';
    expect(() => getConfigPath()).toThrow(/HITL_HOME/);
  });

  it('falls back to the home directory when HITL_HOME is unset', () => {
    delete process.env.HITL_HOME;
    expect(getConfigPath()).toMatch(/[\\/]\.hitl[\\/]config\.json$/);
  });
});
