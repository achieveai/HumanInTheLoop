import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { homedir, hostname } from 'os';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { HitlConfig } from '@hitl/shared';
import { DEFAULT_NTFY_URL } from '@hitl/shared';

const CONFIG_DIR = path.join(homedir(), '.hitl');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

/**
 * Read the HITL config from ~/.hitl/config.json.
 * Throws with a helpful message if the file doesn't exist.
 */
export function loadConfig(): HitlConfig {
  if (!existsSync(CONFIG_FILE)) {
    throw new Error(
      `HITL config not found at ${CONFIG_FILE}\n` +
      `Run "hitl init" to create one, or manually create the file with:\n` +
      JSON.stringify(generateDefaultConfig(), null, 2)
    );
  }

  const raw = readFileSync(CONFIG_FILE, 'utf-8');
  const parsed = JSON.parse(raw) as Partial<HitlConfig>;

  if (!parsed.topicId || typeof parsed.topicId !== 'string') {
    throw new Error(`Invalid config: "topicId" is required in ${CONFIG_FILE}`);
  }

  return {
    topicId: parsed.topicId,
    ntfyUrl: parsed.ntfyUrl ?? DEFAULT_NTFY_URL,
    deviceName: parsed.deviceName || hostname(),
    soundEnabled: parsed.soundEnabled !== false,
  };
}

/**
 * Generate a default config with a fresh topic GUID.
 */
export function generateDefaultConfig(): HitlConfig {
  return {
    topicId: `hitl-${uuidv4()}`,
    ntfyUrl: DEFAULT_NTFY_URL,
    deviceName: hostname(),
    soundEnabled: true,
  };
}

/**
 * Save a config object to ~/.hitl/config.json.
 */
export function saveConfig(config: HitlConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

/**
 * Get the path to the config file.
 */
export function getConfigPath(): string {
  return CONFIG_FILE;
}
