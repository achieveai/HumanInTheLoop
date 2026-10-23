import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import net from 'net';
import {
  MAX_FILE_BYTES, claudeMemoryDir, readRegistry, registerReplica, sharedDir, syncKey, syncReplica, type Replica,
} from '../memory/sync.js';
import { runSessionStartHook } from '../memory/hook.js';
import { askHolder, lockAddress, runLocked, tryHoldLock } from '../memory/lock.js';

const KEY = 'github.com/example/memtest';
let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'hitl-memory-'));
  process.env.HITL_MEMORY_ROOT = path.join(root, 'memory');
  process.env.HITL_CLAUDE_PROJECTS_DIR = path.join(root, 'claude-projects');
});

afterEach(() => {
  delete process.env.HITL_MEMORY_ROOT;
  delete process.env.HITL_CLAUDE_PROJECTS_DIR;
  rmSync(root, { recursive: true, force: true });
});

function replica(name: string, host: Replica['host'] = 'codex'): Replica {
  const dir = path.join(root, name, '.hitl', 'memory');
  mkdirSync(dir, { recursive: true });
  return { path: dir, host };
}
const write = (r: Replica, file: string, text: string) => writeFileSync(path.join(r.path, file), text);
const read = (dir: string, file: string) => (existsSync(path.join(dir, file)) ? readFileSync(path.join(dir, file), 'utf8') : null);
const everywhere = (replicas: Replica[], file: string) =>
  [...replicas.map(r => read(r.path, file)), read(sharedDir(KEY), file)];

/** Two replicas that have both synced once, sharing `fact.md`. */
function twoInStep(): [Replica, Replica] {
  const a = replica('a');
  const b = replica('b');
  write(a, 'fact.md', 'line one\nline two\n');
  for (const r of [a, b]) registerReplica(KEY, r);
  syncKey(KEY);
  return [a, b];
}

describe('syncKey', () => {
  it('brings a fresh replica up to the shared folder', () => {
    const [, b] = twoInStep();
    expect(read(b.path, 'fact.md')).toBe('line one\nline two\n');
  });

  it('ends with the same bytes everywhere when two replicas edit the same line, keeping both', () => {
    const [a, b] = twoInStep();
    write(a, 'fact.md', 'line one\nline two from a\n');
    write(b, 'fact.md', 'line one\nline two from b\n');

    const result = syncKey(KEY);

    expect(result.clashed).toEqual(['fact.md']);
    expect(new Set(everywhere([a, b], 'fact.md'))).toEqual(new Set(['line one\nline two from a\nline two from b\n']));
    expect(readFileSync(path.join(root, 'memory', '.sync', KEY, 'clashes.jsonl'), 'utf8')).toContain('fact.md');
  });

  it('lets an edit beat a concurrent delete', () => {
    const [a, b] = twoInStep();
    rmSync(path.join(a.path, 'fact.md'));
    write(b, 'fact.md', 'line one\nline two edited\n');
    syncKey(KEY);
    expect(new Set(everywhere([a, b], 'fact.md'))).toEqual(new Set(['line one\nline two edited\n']));
  });

  it('removes a file everywhere when one side deletes it and nobody edits it', () => {
    const [a, b] = twoInStep();
    rmSync(path.join(b.path, 'fact.md'));
    syncKey(KEY);
    expect(everywhere([a, b], 'fact.md')).toEqual([null, null, null]);
  });

  it('syncs only top-level .md files and skips ones over the size cap', () => {
    const [a, b] = twoInStep();
    write(a, 'notes.txt', 'not memory');
    write(a, 'huge.md', 'x'.repeat(MAX_FILE_BYTES + 1));
    const result = syncKey(KEY);
    expect(result.skipped).toEqual(['huge.md']);
    expect(readdirSync(b.path).sort()).toEqual(['fact.md']);
  });

  it('backs up a folder that already holds memories before its first sync', () => {
    const a = replica('a');
    write(a, 'fact.md', 'mine\n');
    syncReplica(KEY, a);
    const backups = readdirSync(path.join(root, 'memory', '.sync', KEY, 'backups'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(path.join(root, 'memory', '.sync', KEY, 'backups', backups[0], 'fact.md'), 'utf8')).toBe('mine\n');
  });

  it('forgets a Codex replica whose clone is gone, but never a Claude one, which Claude creates lazily', () => {
    const gone = replica('gone');
    const claude = { path: path.join(root, 'claude-projects', 'not-created-yet', 'memory'), host: 'claude' as const };
    registerReplica(KEY, gone);
    registerReplica(KEY, claude);
    rmSync(path.join(root, 'gone'), { recursive: true });
    write(replica('live'), 'fact.md', 'x\n');
    registerReplica(KEY, replica('live'));

    syncKey(KEY);

    const kept = Object.values(readRegistry()[KEY]).map(r => r.path);
    expect(kept).not.toContain(gone.path);
    expect(kept).toContain(claude.path);
    expect(read(claude.path, 'fact.md')).toBe('x\n');
  });
});

describe('claudeMemoryDir', () => {
  it('uses Claude’s own folder naming', () => {
    expect(claudeMemoryDir('B:\\sources\\Hitl_MCP')).toBe(path.join(root, 'claude-projects', 'B--sources-Hitl-MCP', 'memory'));
  });
});

describe('runSessionStartHook', () => {
  let clone: string;
  beforeEach(() => {
    clone = path.join(root, 'clone');
    mkdirSync(clone);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: clone, stdio: 'pipe' });
    git('init', '-q');
    git('remote', 'add', 'origin', 'git@github.com:Example/MemTest.git');
    mkdirSync(sharedDir(KEY), { recursive: true });
    writeFileSync(path.join(sharedDir(KEY), 'MEMORY.md'), '- [Fact](fact.md) — a fact\n');
  });

  it('gives Codex the folder, the rules and the index in Claude’s hook format, and hides the folder from git', async () => {
    const out = JSON.parse(await runSessionStartHook(JSON.stringify({ cwd: clone, session_id: 's' }), 'codex'));
    const context: string = out.hookSpecificOutput.additionalContext;
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
    // git reports the long form of the temp path, so match its tail.
    expect(context).toMatch(/clone[\\/]\.hitl[\\/]memory/);
    expect(context).toContain('- [Fact](fact.md) — a fact');
    expect(readFileSync(path.join(clone, '.git', 'info', 'exclude'), 'utf8')).toContain('/.hitl/');
    expect(execFileSync('git', ['status', '--short'], { cwd: clone, encoding: 'utf8' })).toBe('');
  });

  it('gives Copilot a top-level additionalContext', async () => {
    const out = JSON.parse(await runSessionStartHook(JSON.stringify({ cwd: clone, sessionId: 's' }), 'copilot'));
    expect(Object.keys(out)).toEqual(['additionalContext']);
  });

  it('tells Claude only when the sync changed its index', async () => {
    const input = JSON.stringify({ cwd: clone });
    const first = JSON.parse(await runSessionStartHook(input, 'claude'));
    expect(first.hookSpecificOutput.additionalContext).toContain('- [Fact](fact.md)');
    expect(await runSessionStartHook(input, 'claude')).toBe('');
  });

  it('prints nothing outside git', async () => {
    expect(await runSessionStartHook(JSON.stringify({ cwd: root }), 'codex')).toBe('');
  });

  it('returns the cached index and a warning when the sync holder fails', async () => {
    const cached = path.join(clone, '.hitl', 'memory');
    mkdirSync(cached, { recursive: true });
    writeFileSync(path.join(cached, 'MEMORY.md'), '- Cached memory stays available\n');
    const warn = jest.spyOn(console, 'error').mockImplementation(() => {});
    const holder = await tryHoldLock(() => { throw new Error('holder unavailable'); });
    try {
      const out = await runSessionStartHook(JSON.stringify({ cwd: clone }), 'codex');
      expect(out).toContain('Cached memory stays available');
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/sync.*cached memory/i));
    } finally {
      warn.mockRestore();
      await new Promise<void>(resolve => holder!.close(() => resolve()));
    }
  });
});

describe('lock', () => {
  it('has one holder; others hand their request to it', async () => {
    const seen: string[] = [];
    const holder = await tryHoldLock(request => {
      seen.push(request.key);
      return 'done by holder';
    });
    try {
      expect(holder).not.toBeNull();
      expect(await tryHoldLock(() => 'second')).toBeNull();
      expect(await runLocked({ op: 'sync', key: 'k1' }, () => 'done locally')).toBe('done by holder');
      expect(seen).toEqual(['k1']);
    } finally {
      await new Promise(resolve => holder!.close(resolve));
    }
  });

  it('runs the request itself, then frees the lock, when nobody holds it', async () => {
    expect(await runLocked({ op: 'sync', key: 'k' }, () => 'done locally')).toBe('done locally');
    await expect(askHolder({ op: 'sync', key: 'k' }, 1000)).rejects.toThrow();
  });

  it('stops waiting at the total deadline when a holder never replies', async () => {
    const sockets = new Set<net.Socket>();
    let received!: () => void;
    const requestReceived = new Promise<void>(resolve => { received = resolve; });
    const holder = net.createServer(socket => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.once('data', () => received());
    });
    // Unix sockets need their parent directory; Windows named pipes do not.
    mkdirSync(path.join(root, 'memory', '.sync'), { recursive: true });
    await new Promise<void>(resolve => holder.listen(lockAddress(), resolve));
    jest.useFakeTimers();
    let outcome = 'pending';
    const work = runLocked({ op: 'sync', key: 'k' }, () => 'local', 2000)
      .then(() => { outcome = 'resolved'; }, () => { outcome = 'rejected'; });
    try {
      await requestReceived;
      await jest.advanceTimersByTimeAsync(2000);
      expect(outcome).toBe('rejected');
    } finally {
      jest.useRealTimers();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => holder.close(() => resolve()));
      await work;
    }
  });
});
