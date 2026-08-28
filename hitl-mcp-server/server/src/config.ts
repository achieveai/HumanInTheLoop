import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'fs';
import { homedir, hostname } from 'os';
import path from 'path';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import type { HitlConfig } from './types.js';
import { DEFAULT_NTFY_URL } from './types.js';

/**
 * Root of this install's state, mirroring `hitl_transport::paths::hitl_dir()`.
 *
 * `HITL_HOME` has to be honoured here, not just in Rust. The Rust side resolves
 * `config.json` through `hitl_dir()`, while this — the only thing that ever
 * *writes* that file, via `hitl init` — used to hardcode `~/.hitl`. Under
 * `HITL_HOME` the two languages then read and wrote different files, and the
 * Rust binaries answered with "Run 'hitl init' to create one", advice that
 * rewrites the same wrong path forever. `ntfy-transport.ts` and
 * `snapshot-store.ts` already resolve their subdirectories this way; config was
 * the odd one out.
 *
 * Read per call rather than at import so tests and a relaunched process both
 * see the current environment. Empty is rejected rather than treated as unset,
 * matching the Rust rule — an empty value there would silently mean the process
 * working directory.
 */
function hitlDir(): string {
  const override = process.env.HITL_HOME;
  if (override !== undefined) {
    if (override.trim() === '') {
      throw new Error('HITL_HOME is set but empty; unset it or give it a real path');
    }
    return override;
  }
  return path.join(homedir(), '.hitl');
}

function configFile(): string {
  return path.join(hitlDir(), 'config.json');
}

/**
 * Read the HITL config from this install's config.json (see hitlDir).
 * Throws with a helpful message if the file doesn't exist.
 */
export function loadConfig(): HitlConfig {
  const file = configFile();
  if (!existsSync(file)) {
    throw new Error(
      `HITL config not found at ${file}\n` +
      `Run "hitl init" to create one, or manually create the file with:\n` +
      JSON.stringify(generateDefaultConfig(), null, 2)
    );
  }

  const raw = readFileSync(file, 'utf-8');
  const parsed = JSON.parse(raw) as Partial<HitlConfig>;

  if (!parsed.topicId || typeof parsed.topicId !== 'string') {
    throw new Error(`Invalid config: "topicId" is required in ${file}`);
  }

  return {
    topicId: parsed.topicId,
    ntfyUrl: parsed.ntfyUrl ?? DEFAULT_NTFY_URL,
    deviceName: parsed.deviceName || hostname(),
    soundEnabled: parsed.soundEnabled !== false,
    encryptionKey: parsed.encryptionKey || undefined,
    identityEnabled: parsed.identityEnabled !== false,
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
    encryptionKey: crypto.randomBytes(32).toString('hex'),
    identityEnabled: true,
  };
}

/**
 * Save a config object to this install's config.json (see hitlDir).
 */
export function saveConfig(config: HitlConfig): void {
  mkdirSync(hitlDir(), { recursive: true });
  // Keep the outgoing config. A regenerated default silently swaps in a
  // public ntfyUrl, a fresh topic and a fresh encryption key; without this
  // copy a self-hosted setup is unrecoverable once the original is gone.
  const target = configFile();
  if (existsSync(target)) {
    try {
      copyFileSync(target, `${target}.bak`);
    } catch {
      // A backup that cannot be written must not block saving the config.
    }
  }
  writeFileSync(target, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

/**
 * Get the path to the config file.
 */
export function getConfigPath(): string {
  return configFile();
}
