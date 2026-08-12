import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';

/** The env var Claude Code reads to decide when to auto-background a long-running MCP tool call. */
export const AUTO_BACKGROUND_ENV_KEY = 'CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS';

/** The value that disables auto-backgrounding, so a blocking HITL tool call is never yanked away before the human answers. */
export const AUTO_BACKGROUND_TARGET_VALUE = '0';

/** Result of checking whether the auto-background guard is in effect. */
export interface AutoBackgroundStatus {
  /** True if the guard is already effective now, or will be after the next Claude Code restart. */
  active: boolean;
  /** True if the *currently running* process inherited the target value (in effect right now). */
  activeInEnv: boolean;
  /** True if ~/.claude/settings.json has the target value queued for the next restart. */
  configuredForRestart: boolean;
  /** Raw value observed in the inherited env, if any. */
  envValue?: string;
  /** Raw value observed in settings.json's `env` block, if any. */
  settingsValue?: string;
}

/** Locate the host Claude Code settings file: ~/.claude/settings.json */
export function getHostSettingsPath(): string {
  return path.join(homedir(), '.claude', 'settings.json');
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Read a Claude Code settings.json file. Returns an empty object when the
 * file is missing or blank, so callers can merge into the result unconditionally.
 * Malformed JSON is not swallowed — it throws, so a caller can surface a clear
 * error instead of silently discarding a user's existing settings.
 */
export function readHostSettings(settingsPath: string = getHostSettingsPath()): Record<string, unknown> {
  if (!existsSync(settingsPath)) return {};
  const raw = readFileSync(settingsPath, 'utf-8');
  if (!raw.trim()) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

/**
 * Merge the auto-background remediation value into an existing settings
 * object, preserving every other top-level key and every other `env` entry.
 * Pure function — never mutates its input. Applying it to its own output is
 * idempotent (produces an equal object).
 */
export function mergeAutoBackgroundSetting(
  existingSettings: Record<string, unknown>
): Record<string, unknown> {
  const existingEnv = asRecord(existingSettings.env);

  return {
    ...existingSettings,
    env: {
      ...existingEnv,
      [AUTO_BACKGROUND_ENV_KEY]: AUTO_BACKGROUND_TARGET_VALUE,
    },
  };
}

/**
 * Detect whether the auto-background guard is already in effect:
 *  - `activeInEnv`: the currently running process inherited it — in effect now.
 *  - `configuredForRestart`: ~/.claude/settings.json has it queued — takes
 *    effect the next time Claude Code restarts, not for the current session.
 *
 * Never throws: a missing or malformed settings.json is treated the same as
 * "not configured", since this is a read-only diagnostic.
 */
export function detectAutoBackgroundStatus(
  env: NodeJS.ProcessEnv = process.env,
  settingsPath: string = getHostSettingsPath()
): AutoBackgroundStatus {
  const envValue = env[AUTO_BACKGROUND_ENV_KEY];
  const activeInEnv = envValue === AUTO_BACKGROUND_TARGET_VALUE;

  let settings: Record<string, unknown>;
  try {
    settings = readHostSettings(settingsPath);
  } catch {
    settings = {};
  }

  const settingsEnv = asRecord(settings.env);
  const rawSettingsValue = settingsEnv[AUTO_BACKGROUND_ENV_KEY];
  const settingsValue = typeof rawSettingsValue === 'string' ? rawSettingsValue : undefined;
  const configuredForRestart = settingsValue === AUTO_BACKGROUND_TARGET_VALUE;

  return {
    active: activeInEnv || configuredForRestart,
    activeInEnv,
    configuredForRestart,
    envValue,
    settingsValue,
  };
}

/**
 * Build reusable, human-readable remediation text for when the auto-background
 * guard is not yet active. Shared by the setup diagnostic step, and any future
 * CLI/UX surface that needs to explain the same fix.
 */
export function buildAutoBackgroundRemediationText(
  settingsPath: string = getHostSettingsPath()
): string {
  return [
    `${AUTO_BACKGROUND_ENV_KEY} is not set to "${AUTO_BACKGROUND_TARGET_VALUE}", so Claude Code may auto-background a long-running HITL tool call before you get a chance to respond.`,
    `Fix: merge the following into ${settingsPath} (preserve every other key):`,
    `  { "env": { "${AUTO_BACKGROUND_ENV_KEY}": "${AUTO_BACKGROUND_TARGET_VALUE}" } }`,
    `Restart Claude Code afterward for the change to take effect.`,
  ].join('\n');
}
