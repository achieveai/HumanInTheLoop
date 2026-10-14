import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';
import { sessionDir } from './agent-messages.js';

/**
 * The name and objective an agent gave its session with `NameSession`.
 *
 * Saved beside the session's other local state, keyed by its tag, so a resumed
 * conversation (same tag, new server process) keeps the name it chose.
 */
export interface SessionName {
  name: string;
  objective: string;
}

export const SESSION_NAME_MAX = 40;
export const SESSION_OBJECTIVE_MAX = 200;

const FILE = 'session-name.json';

/** The saved name for `tag`, or null when the session has none (or it is unreadable). */
export function readSessionName(tag: string): SessionName | null {
  try {
    const saved = JSON.parse(readFileSync(path.join(sessionDir(tag), FILE), 'utf-8')) as Partial<SessionName>;
    if (typeof saved.name !== 'string' || saved.name.trim() === '') return null;
    return { name: saved.name, objective: typeof saved.objective === 'string' ? saved.objective : '' };
  } catch {
    return null;
  }
}

/** Save `name` for `tag`, replacing any earlier one. Written whole, then renamed into place. */
export function saveSessionName(tag: string, name: SessionName): void {
  const dir = sessionDir(tag);
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, FILE);
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(name) + '\n', 'utf-8');
  renameSync(temp, target);
}

/** Thrown for a name or objective the tool must refuse. */
export class SessionNameError extends Error {}

/** Check and tidy `NameSession` arguments: one line each, within their limits. */
export function parseSessionName(args: Record<string, unknown> | undefined): SessionName {
  const field = (key: 'name' | 'objective', max: number): string => {
    const value = args?.[key];
    if (typeof value !== 'string' || value.trim() === '') throw new SessionNameError(`Missing required parameter: ${key}`);
    const text = value.replace(/\s+/g, ' ').trim();
    if (text.length > max) throw new SessionNameError(`${key} is ${text.length} characters; shorten it to ${max} or fewer`);
    return text;
  };
  return { name: field('name', SESSION_NAME_MAX), objective: field('objective', SESSION_OBJECTIVE_MAX) };
}
