import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { chatQuestionsStatus, setChatQuestions, type ChatHost } from '../chat-questions.js';

const NOW = new Date('2026-10-19T10:20:30Z');
let home: string;
const options = () => ({ home, env: {}, now: NOW });

const files: Record<ChatHost, string> = {
  claude: '.claude/settings.json',
  codex: '.codex/config.toml',
  copilot: '.copilot/settings.json',
};
const file = (host: ChatHost) => path.join(home, files[host]);
const read = (host: ChatHost) => readFileSync(file(host), 'utf-8');
const write = (host: ChatHost, text: string) => {
  mkdirSync(path.dirname(file(host)), { recursive: true });
  writeFileSync(file(host), text);
};
const install = (...hosts: ChatHost[]) => hosts.forEach(host => mkdirSync(path.dirname(file(host)), { recursive: true }));
const result = (results: ReturnType<typeof setChatQuestions>, host: ChatHost) => results.find(r => r.host === host)!;

beforeEach(() => { home = mkdtempSync(path.join(tmpdir(), 'hitl-chat-questions-')); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('chat questions', () => {
  it('leaves hosts that are not installed alone', () => {
    const results = setChatQuestions(false, options());
    expect(results.map(r => r.state)).toEqual(['not_installed', 'not_installed', 'not_installed']);
    expect(existsSync(path.join(home, '.claude'))).toBe(false);
  });

  it('turns all three off in new files, then reports them off', () => {
    install('claude', 'codex', 'copilot');
    const results = setChatQuestions(false, options());
    expect(results.every(r => r.state === 'off' && r.changed && !r.backup)).toBe(true);
    expect(JSON.parse(read('claude'))).toEqual({ permissions: { deny: ['AskUserQuestion'] } });
    expect(read('codex')).toBe('[tools.experimental_request_user_input]\nenabled = false\n');
    expect(JSON.parse(read('copilot'))).toEqual({ askUser: false });
    expect(chatQuestionsStatus(options()).map(r => r.state)).toEqual(['off', 'off', 'off']);
  });

  it('keeps every other setting, backs up first, and does nothing the second time', () => {
    const claude = { model: 'opus', permissions: { allow: ['Read'], deny: ['Edit(**/*-v2*)'] }, hooks: { Stop: [] } };
    write('claude', JSON.stringify(claude, null, 2));
    write('copilot', JSON.stringify({ logLevel: 'info', askUser: true }));
    const results = setChatQuestions(false, options());

    expect(JSON.parse(read('claude'))).toEqual({ ...claude, permissions: { allow: ['Read'], deny: ['Edit(**/*-v2*)', 'AskUserQuestion'] } });
    expect(JSON.parse(read('copilot'))).toEqual({ logLevel: 'info', askUser: false });
    expect(result(results, 'claude').backup).toBe(`${file('claude')}.bak-20261019102030`);
    expect(JSON.parse(readFileSync(result(results, 'claude').backup!, 'utf-8'))).toEqual(claude);

    const again = setChatQuestions(false, options());
    expect(again.filter(r => r.state === 'off').every(r => r.changed === false)).toBe(true);
    expect(readdirSync(path.dirname(file('claude'))).filter(f => f.includes('.bak-'))).toHaveLength(1);
  });

  it('on undoes off', () => {
    write('claude', JSON.stringify({ permissions: { deny: ['Edit(x)'] } }));
    write('copilot', JSON.stringify({ logLevel: 'info' }));
    write('codex', 'model = "o3"\n');
    setChatQuestions(false, options());
    const results = setChatQuestions(true, { ...options(), now: new Date('2026-10-19T10:21:00Z') });

    expect(results.map(r => r.state)).toEqual(['on', 'on', 'on']);
    expect(JSON.parse(read('claude'))).toEqual({ permissions: { deny: ['Edit(x)'] } });
    expect(JSON.parse(read('copilot'))).toEqual({ logLevel: 'info' });
    expect(read('codex')).toBe('model = "o3"\n\n[tools.experimental_request_user_input]\nenabled = true\n');
  });

  describe('Codex config.toml', () => {
    it('appends the table, keeping comments and CRLF line endings', () => {
      write('codex', '# mine\r\nmodel = "o3"\r\n\r\n[features]\r\nhooks = true');
      setChatQuestions(false, options());
      expect(read('codex')).toBe('# mine\r\nmodel = "o3"\r\n\r\n[features]\r\nhooks = true\r\n\r\n[tools.experimental_request_user_input]\r\nenabled = false\r\n');
    });

    it('flips an existing enabled = true in its table', () => {
      write('codex', '[tools.experimental_request_user_input]\nenabled = true # was on\n\n[features]\nx = 1\n');
      setChatQuestions(false, options());
      expect(read('codex')).toBe('[tools.experimental_request_user_input]\nenabled = false # was on\n\n[features]\nx = 1\n');
    });

    it('adds enabled = false to an existing table without it', () => {
      write('codex', '[tools.experimental_request_user_input]\n\n[features]\n');
      setChatQuestions(false, options());
      expect(read('codex')).toBe('[tools.experimental_request_user_input]\nenabled = false\n\n[features]\n');
    });

    it('flips the short form under [tools]', () => {
      write('codex', '[tools]\nweb_search = true\nexperimental_request_user_input = true\n');
      setChatQuestions(false, options());
      expect(read('codex')).toBe('[tools]\nweb_search = true\nexperimental_request_user_input = false\n');
    });

    it('leaves a form it does not know alone', () => {
      const odd = 'tools = { experimental_request_user_input = { enabled = true } }\n';
      write('codex', odd);
      const codex = result(setChatQuestions(false, options()), 'codex');
      expect(codex.state).toBe('unknown');
      expect(codex.note).toContain('by hand');
      expect(read('codex')).toBe(odd);
    });

    it('does not mistake another table\'s enabled for its own', () => {
      write('codex', '[mcp_servers.hitl]\nenabled = false\n');
      expect(result(chatQuestionsStatus(options()), 'codex').state).toBe('on');
      // An array of tables after the tool table starts a new table too.
      write('codex', '[tools.experimental_request_user_input]\nenabled = true\n\n[[hooks.Stop]]\nenabled = false\n');
      expect(result(chatQuestionsStatus(options()), 'codex').state).toBe('on');
    });

    it('reads the value, not a comment after it', () => {
      write('codex', '[tools.experimental_request_user_input]\nenabled = true # was = false\n');
      expect(result(chatQuestionsStatus(options()), 'codex').state).toBe('on');
    });

    it('understands a quoted table name', () => {
      write('codex', '[tools."experimental_request_user_input"]\nenabled = true\n');
      setChatQuestions(false, options());
      expect(read('codex')).toBe('[tools."experimental_request_user_input"]\nenabled = false\n');
    });

    it('leaves a top-level tools table or a duplicate table alone', () => {
      for (const odd of [
        'tools = { web_search = true }\n',
        'tools.web_search = true\n',
        '[tools.experimental_request_user_input]\nenabled = true\n[tools.experimental_request_user_input]\n',
      ]) {
        write('codex', odd);
        expect(result(setChatQuestions(false, options()), 'codex').state).toBe('unknown');
        expect(read('codex')).toBe(odd);
      }
    });
  });

  it('leaves a file with comments or bad JSON alone and says what to set', () => {
    const jsonc = '{\n  // mine\n  "logLevel": "info"\n}\n';
    write('copilot', jsonc);
    write('claude', '{ "permissions": { "deny": "AskUserQuestion" } }');
    const results = setChatQuestions(false, options());
    expect(result(results, 'copilot')).toMatchObject({ state: 'unknown', note: expect.stringContaining('"askUser": false') });
    expect(result(results, 'claude').state).toBe('unknown');
    expect(read('copilot')).toBe(jsonc);
  });

  it('reads past a BOM and keeps it', () => {
    write('claude', '﻿{ "model": "opus" }');
    setChatQuestions(false, options());
    const text = read('claude');
    expect(text.startsWith('﻿')).toBe(true);
    expect(JSON.parse(text.slice(1))).toEqual({ model: 'opus', permissions: { deny: ['AskUserQuestion'] } });
  });

  it('writes through a symlink, so a dotfiles repo stays the source', () => {
    const real = path.join(home, 'dotfiles', 'settings.json');
    mkdirSync(path.dirname(real), { recursive: true });
    writeFileSync(real, '{}');
    mkdirSync(path.join(home, '.claude'));
    try {
      symlinkSync(real, file('claude'), 'file');
    } catch {
      return; // Windows without symlink rights: nothing to check.
    }
    setChatQuestions(false, options());
    expect(lstatSync(file('claude')).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, 'utf-8'))).toEqual({ permissions: { deny: ['AskUserQuestion'] } });
  });

  it('follows CLAUDE_CONFIG_DIR, CODEX_HOME and COPILOT_HOME', () => {
    const env = { CLAUDE_CONFIG_DIR: path.join(home, 'c'), CODEX_HOME: path.join(home, 'x'), COPILOT_HOME: path.join(home, 'p') };
    Object.values(env).forEach(dir => mkdirSync(dir));
    const results = setChatQuestions(false, { home, env, now: NOW });
    expect(results.map(r => r.file)).toEqual([
      path.join(env.CLAUDE_CONFIG_DIR, 'settings.json'),
      path.join(env.CODEX_HOME, 'config.toml'),
      path.join(env.COPILOT_HOME, 'settings.json'),
    ]);
    expect(results.every(r => r.state === 'off')).toBe(true);
  });
});
