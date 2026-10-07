import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { decideStop, runStopHook, BLOCK_REASON, type TranscriptEntry } from '../handoff-hook.js';

// Shapes copied from real Claude Code transcripts (desktop app, 2026-10).
let nextId = 0;
const prompt = (text = 'do the thing'): TranscriptEntry =>
  ({ type: 'user', entrypoint: 'claude-desktop', message: { content: text } });
function tool(name = 'Bash', result: unknown = 'ok', isError = false): TranscriptEntry[] {
  const id = `toolu_${nextId++}`;
  return [
    { type: 'assistant', entrypoint: 'claude-desktop', message: { content: [{ type: 'tool_use', id, name }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: result, ...(isError ? { is_error: true } : {}) }] } },
  ];
}
const handOff = (action: 'continue' | 'end') =>
  tool('mcp__hitl__HandOff', [{ type: 'text', text: JSON.stringify({ success: true, action }) }]);
const ourBlock = (): TranscriptEntry =>
  ({ type: 'user', isMeta: true, message: { content: `Stop hook feedback:\n${BLOCK_REASON}` } });
const say = (text: string): TranscriptEntry =>
  ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

const env = {} as NodeJS.ProcessEnv;

describe('decideStop', () => {
  it('blocks when the agent did work and stops without HandOff', () => {
    expect(decideStop([prompt(), ...tool(), say('Done.')], env).block).toBe(true);
  });

  it('allows a plain chat answer that used no tools', () => {
    expect(decideStop([prompt('what is 2+2?'), say('4')], env)).toMatchObject({ block: false });
  });

  it('allows -p and SDK runs', () => {
    const entries = [prompt(), ...tool()].map(e => ({ ...e, entrypoint: 'sdk-cli' }));
    expect(decideStop(entries, env)).toMatchObject({ block: false, why: 'non-interactive entrypoint sdk-cli' });
  });

  it('allows when HITL_HANDOFF=0', () => {
    expect(decideStop([prompt(), ...tool()], { HITL_HANDOFF: '0' })).toMatchObject({ block: false });
  });

  it('allows after the user chooses End', () => {
    expect(decideStop([prompt(), ...tool(), ...handOff('end'), say('Stopping.')], env))
      .toMatchObject({ block: false, why: 'user chose End' });
  });

  it('allows when HandOff errored, so an unreachable Inbox cannot loop', () => {
    const entries = [prompt(), ...tool(), ourBlock(), ...tool('mcp__hitl__HandOff', 'MCP error', true)];
    expect(decideStop(entries, env)).toMatchObject({ block: false, why: 'HandOff failed' });
  });

  it('allows after one ignored block', () => {
    expect(decideStop([prompt(), ...tool(), ourBlock(), say('Done, really.')], env))
      .toMatchObject({ block: false, why: 'agent ignored the previous block' });
  });

  it('keeps blocking across three handoff cycles in one turn, then allows End', () => {
    const t: TranscriptEntry[] = [prompt(), ...tool()];
    expect(decideStop(t, env).block).toBe(true);

    t.push(ourBlock(), ...handOff('continue'), ...tool());
    expect(decideStop(t, env)).toMatchObject({ block: true, why: 'new work since the last HandOff' });

    t.push(ourBlock(), ...handOff('continue'), ...tool());
    expect(decideStop(t, env).block).toBe(true);

    t.push(ourBlock(), ...handOff('end'));
    expect(decideStop(t, env)).toMatchObject({ block: false, why: 'user chose End' });
  });

  it('does not let End from an earlier turn excuse new work', () => {
    const entries = [prompt(), ...tool(), ...handOff('end'), prompt('one more thing'), ...tool()];
    expect(decideStop(entries, env).block).toBe(true);
  });

  it('ignores subagent (sidechain) tool calls', () => {
    const sidechain = tool().map(e => ({ ...e, isSidechain: true }));
    expect(decideStop([prompt(), ...sidechain, say('hi')], env)).toMatchObject({ block: false });
  });
});

describe('runStopHook', () => {
  let dir: string | undefined;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  function transcript(entries: TranscriptEntry[]): string {
    dir = mkdtempSync(path.join(tmpdir(), 'hitl-hook-'));
    const file = path.join(dir, 't.jsonl');
    writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n{not json\n');
    return file;
  }

  it('prints a top-level block decision for Claude Code', () => {
    const out = runStopHook(JSON.stringify({ transcript_path: transcript([prompt(), ...tool()]) }), env);
    expect(JSON.parse(out)).toEqual({ decision: 'block', reason: BLOCK_REASON });
  });

  it('prints nothing (allow) on bad input or a missing transcript', () => {
    expect(runStopHook('not json', env)).toBe('');
    expect(runStopHook(JSON.stringify({ transcript_path: '/no/such/file.jsonl' }), env)).toBe('');
  });
});
