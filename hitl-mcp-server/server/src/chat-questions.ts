import { copyFileSync, existsSync, readFileSync, realpathSync, statSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { writeAtomic } from './host-settings.js';

/**
 * Turn each agent host's built-in "ask the user in chat" tool off or on, so
 * agents ask through HITL's AskUserQuestion instead. Each host reads a user
 * config file that its desktop app shares:
 *  - Claude Code: settings.json `permissions.deny` gets "AskUserQuestion".
 *  - Codex: config.toml `[tools.experimental_request_user_input] enabled = false`.
 *  - Copilot CLI: settings.json `"askUser": false`.
 *
 * Only hosts installed here (their config folder exists) are touched. Each
 * changed file is backed up first and written atomically; every other setting
 * is kept. A file in a shape we don't recognise is left alone and reported.
 */

export type ChatHost = 'claude' | 'codex' | 'copilot';

export type ChatQuestionsState = 'off' | 'on' | 'not_installed' | 'unknown';

export interface HostChatQuestions {
  host: ChatHost;
  /** The config file this host reads. */
  file: string;
  state: ChatQuestionsState;
  /** True when this call changed the file. */
  changed?: boolean;
  /** The copy made before the change. */
  backup?: string;
  /** Why the state is unknown: what to set by hand. */
  note?: string;
}

/** The built-in question tool on each host, as its hooks and config name it. */
export const BUILT_IN_QUESTION_TOOLS: Record<ChatHost, string> = {
  claude: 'AskUserQuestion',
  codex: 'request_user_input',
  copilot: 'ask_user',
};

export interface ChatQuestionsEnv {
  home?: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}

function hostFile(host: ChatHost, home: string, env: NodeJS.ProcessEnv): string {
  switch (host) {
    case 'claude': return path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'settings.json');
    case 'codex': return path.join(env.CODEX_HOME || path.join(home, '.codex'), 'config.toml');
    case 'copilot': return path.join(env.COPILOT_HOME || path.join(home, '.copilot'), 'settings.json');
  }
}

/** A host's edit: the new text for `off`/`on`, or why it can't tell. */
interface Edit {
  state: 'off' | 'on' | 'unknown';
  apply(off: boolean): string;
  note?: string;
}

const MANUAL = {
  claude: 'Add "AskUserQuestion" to permissions.deny in this file by hand.',
  codex: 'Set [tools.experimental_request_user_input] enabled = false in this file by hand.',
  copilot: 'Set "askUser": false in this file by hand.',
};

function unknown(host: ChatHost): Edit {
  return { state: 'unknown', apply: () => { throw new Error(MANUAL[host]); }, note: MANUAL[host] };
}

function parseObject(text: string): Record<string, unknown> | undefined {
  if (!text.trim()) return {};
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    // Copilot allows comments in settings.json; rewriting would drop them.
    return undefined;
  }
}

function json(value: Record<string, unknown>): string {
  return JSON.stringify(value, null, 2) + '\n';
}

function claudeEdit(text: string): Edit {
  const settings = parseObject(text);
  const permissions = settings?.permissions ?? {};
  if (!settings || typeof permissions !== 'object' || Array.isArray(permissions)) return unknown('claude');
  const deny = (permissions as Record<string, unknown>).deny ?? [];
  if (!Array.isArray(deny)) return unknown('claude');
  const tool = BUILT_IN_QUESTION_TOOLS.claude;
  return {
    state: deny.includes(tool) ? 'off' : 'on',
    apply: off => json({
      ...settings,
      permissions: {
        ...(permissions as Record<string, unknown>),
        deny: off ? [...deny.filter(rule => rule !== tool), tool] : deny.filter(rule => rule !== tool),
      },
    }),
  };
}

function copilotEdit(text: string): Edit {
  const settings = parseObject(text);
  if (!settings) return unknown('copilot');
  return {
    state: settings.askUser === false ? 'off' : 'on',
    apply: off => {
      const { askUser: _, ...rest } = settings;
      return json(off ? { ...rest, askUser: false } : rest);
    },
  };
}

const HEADER = /^\s*(\[\[?)([^\]]*)\]\]?\s*(#.*)?$/;
const TOOL_TABLE = 'tools.experimental_request_user_input';

/** `[a."b"]` reads as `a.b`; an array of tables `[[a]]` as `[[a]]`, so it never matches a plain table. */
function tableName(line: string): string | undefined {
  const match = HEADER.exec(line);
  if (!match) return undefined;
  const name = match[2].replace(/\s+/g, '').replace(/["']/g, '');
  return match[1] === '[[' ? `[[${name}]]` : name;
}

/**
 * Codex TOML, edited as text so comments and layout survive. Two forms are
 * understood: `[tools.experimental_request_user_input]` with `enabled = …`,
 * and `experimental_request_user_input = …` under `[tools]`. Anything else
 * that mentions the key is left alone.
 */
function codexEdit(text: string): Edit {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  let table: string | undefined = '';
  let header = -1;
  let valueLine = -1;
  let valueOff = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*#/.test(lines[i])) continue;
    const name = tableName(lines[i]);
    if (name !== undefined) {
      table = name;
      if (name === TOOL_TABLE) {
        if (header >= 0) return unknown('codex');
        header = i;
      }
      continue;
    }
    // `tools = { … }` or `tools.x = …` at the top level: a new [tools.…] table would clash with it.
    if (table === '' && /^\s*["']?tools["']?\s*[.=]/.test(lines[i])) return unknown('codex');
    if (!lines[i].includes('experimental_request_user_input') && !(table === TOOL_TABLE && /^\s*enabled\s*=/.test(lines[i]))) continue;
    const enabled = /^\s*enabled\s*=\s*(true|false)\s*(#.*)?$/.exec(lines[i]);
    const inline = /^\s*experimental_request_user_input\s*=\s*(true|false)\s*(#.*)?$/.exec(lines[i]);
    if (table === TOOL_TABLE && enabled) { valueLine = i; valueOff = enabled[1] === 'false'; continue; }
    if (table === 'tools' && inline) { valueLine = i; valueOff = inline[1] === 'false'; continue; }
    return unknown('codex');
  }
  const join = (out: string[]) => out.join(newline);
  if (valueLine >= 0) {
    return {
      state: valueOff ? 'off' : 'on',
      apply: turnOff => {
        const out = [...lines];
        out[valueLine] = out[valueLine].replace(/=\s*(true|false)/, `= ${turnOff ? 'false' : 'true'}`);
        return join(out);
      },
    };
  }
  if (header >= 0) {
    return {
      state: 'on',
      apply: turnOff => {
        if (!turnOff) return text;
        const out = [...lines];
        out.splice(header + 1, 0, 'enabled = false');
        return join(out);
      },
    };
  }
  return {
    state: 'on',
    apply: turnOff => {
      if (!turnOff) return text;
      const body = text.length && !text.endsWith('\n') ? text + newline : text;
      const gap = body.trim() ? newline : '';
      return `${body}${gap}[${TOOL_TABLE}]${newline}enabled = false${newline}`;
    },
  };
}

const EDITS: Record<ChatHost, (text: string) => Edit> = { claude: claudeEdit, codex: codexEdit, copilot: copilotEdit };

function stamp(now: Date): string {
  return now.toISOString().replace(/\D/g, '').slice(0, 14);
}

const BOM = '﻿';

function inspect(host: ChatHost, { home = homedir(), env = process.env }: ChatQuestionsEnv) {
  const file = hostFile(host, home, env);
  if (!existsSync(path.dirname(file))) return { file };
  const raw = existsSync(file) ? readFileSync(file, 'utf-8') : '';
  // Windows PowerShell 5 writes a BOM; read past it and keep it.
  const bom = raw.startsWith(BOM) ? BOM : '';
  return { file, bom, edit: EDITS[host](raw.slice(bom.length)) };
}

/** Whether each host's built-in question tool is off, on, or can't be told. */
export function chatQuestionsStatus(options: ChatQuestionsEnv = {}): HostChatQuestions[] {
  return (Object.keys(EDITS) as ChatHost[]).map(host => {
    const { file, edit } = inspect(host, options);
    if (!edit) return { host, file, state: 'not_installed' };
    return { host, file, state: edit.state, ...(edit.note ? { note: edit.note } : {}) };
  });
}

/**
 * Turn the built-in question tools off (`on: false`) or back on. Never
 * throws for one host's file: its error is reported and the others go on.
 */
export function setChatQuestions(on: boolean, options: ChatQuestionsEnv = {}): HostChatQuestions[] {
  const wanted = on ? 'on' : 'off';
  return (Object.keys(EDITS) as ChatHost[]).map(host => {
    let file = '';
    try {
      const found = inspect(host, options);
      file = found.file;
      const { bom, edit } = found;
      if (!edit) return { host, file, state: 'not_installed' };
      if (edit.state === 'unknown') return { host, file, state: 'unknown', note: edit.note };
      if (edit.state === wanted) return { host, file, state: wanted, changed: false };
      const next = edit.apply(!on);
      let backup: string | undefined;
      let target = file;
      let mode: number | undefined;
      if (existsSync(file)) {
        // Write through a symlink (a dotfiles repo) and keep the file's permissions.
        target = realpathSync(file);
        mode = statSync(target).mode & 0o777;
        backup = `${file}.bak-${stamp(options.now ?? new Date())}`;
        copyFileSync(target, backup);
      }
      writeAtomic(target, bom + next, mode);
      return { host, file, state: wanted, changed: true, ...(backup ? { backup } : {}) };
    } catch (error) {
      return { host, file, state: 'unknown', note: error instanceof Error ? error.message : String(error) };
    }
  });
}

const HOST_NAMES: Record<ChatHost, string> = { claude: 'Claude Code', codex: 'Codex', copilot: 'Copilot CLI' };

/** One line per host, for the CLI and setup. */
export function describeChatQuestions(results: HostChatQuestions[]): string[] {
  return results.map(result => {
    const name = `${HOST_NAMES[result.host]} (${BUILT_IN_QUESTION_TOOLS[result.host]})`;
    switch (result.state) {
      case 'not_installed': return `${name}: not installed here`;
      case 'unknown': return `${name}: couldn't change ${result.file}. ${result.note ?? ''}`.trim();
      case 'off': return `${name}: off${result.changed ? ` (updated ${result.file}; backup ${result.backup ?? 'none, new file'})` : ''}`;
      case 'on': return `${name}: on${result.changed ? ` (updated ${result.file}; backup ${result.backup ?? 'none, new file'})` : ''}`;
    }
  });
}
