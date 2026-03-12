import { existsSync } from 'fs';
import { execSync, spawn } from 'child_process';
import { homedir } from 'os';
import path from 'path';
import { saveConfig, generateDefaultConfig, getConfigPath } from './config.js';

/** Result of a single setup step. */
export interface SetupStepResult {
  step: string;
  status: 'ok' | 'created' | 'launched' | 'already_running' | 'not_found' | 'error';
  message: string;
}

/** Aggregated result of the full setup process. */
export interface SetupResult {
  success: boolean;
  steps: SetupStepResult[];
  summary: string;
}

/**
 * Check if a process with the given name is currently running.
 * Uses `tasklist` on Windows and `pgrep` on Unix.
 */
export function isProcessRunning(processName: string): boolean {
  try {
    if (process.platform === 'win32') {
      const output = execSync(
        `tasklist /FI "IMAGENAME eq ${processName}" /NH`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      return output.toLowerCase().includes(processName.toLowerCase());
    } else {
      execSync(`pgrep -x ${processName}`, { stdio: ['pipe', 'pipe', 'pipe'] });
      return true;
    }
  } catch {
    return false;
  }
}

/**
 * Search known locations for the HITL client binary.
 * Returns the first path that exists, or null if none found.
 *
 * @param serverDir - The directory where the compiled server JS lives (e.g. server/dist/)
 */
export function findClientBinary(serverDir: string): string | null {
  const binaryName = process.platform === 'win32' ? 'hitl-client.exe' : 'hitl-client';

  const candidates = [
    // Dev build (relative to server dist → repo root → client)
    path.resolve(serverDir, '..', '..', 'client', 'src-tauri', 'target', 'debug', binaryName),
    // Release build
    path.resolve(serverDir, '..', '..', 'client', 'src-tauri', 'target', 'release', binaryName),
    // Installed location
    path.join(homedir(), '.hitl', binaryName),
  ];

  return candidates.find((p) => existsSync(p)) ?? null;
}

/**
 * Launch the client binary as a fully detached background process.
 */
export function launchClient(binaryPath: string): void {
  const child = spawn(binaryPath, [], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

/**
 * Build a user-friendly "not found" message listing the paths that were searched.
 */
function buildNotFoundMessage(): string {
  const binaryName = process.platform === 'win32' ? 'hitl-client.exe' : 'hitl-client';
  return [
    `HITL client binary not found. Searched locations:`,
    `  - <serverDir>/../../client/src-tauri/target/debug/${binaryName}`,
    `  - <serverDir>/../../client/src-tauri/target/release/${binaryName}`,
    `  - ~/.hitl/${binaryName}`,
    ``,
    `To build the client from source, run:`,
    `  cd client && cargo tauri build`,
  ].join('\n');
}

/**
 * Perform the full HITL client setup:
 *   1. Ensure ~/.hitl/config.json exists
 *   2. Check if the client process is running
 *   3. Find and launch the client binary if needed
 *
 * @param serverDir - The directory of the running server JS (used to resolve relative binary paths)
 */
export async function performSetup(serverDir: string): Promise<SetupResult> {
  const steps: SetupStepResult[] = [];
  let overallSuccess = true;

  // Step 1: Ensure config exists
  const configPath = getConfigPath();
  if (existsSync(configPath)) {
    steps.push({ step: 'config', status: 'ok', message: `Config already exists at ${configPath}` });
  } else {
    try {
      const config = generateDefaultConfig();
      saveConfig(config);
      steps.push({ step: 'config', status: 'created', message: `Created default config at ${configPath}` });
    } catch (error) {
      overallSuccess = false;
      steps.push({
        step: 'config',
        status: 'error',
        message: `Failed to create config: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  // Step 2: Check if client is already running
  const binaryName = process.platform === 'win32' ? 'hitl-client.exe' : 'hitl-client';
  if (isProcessRunning(binaryName)) {
    steps.push({ step: 'client', status: 'already_running', message: 'HITL client is already running' });
    return { success: overallSuccess, steps, summary: formatSummary(steps) };
  }

  // Step 3: Find and launch binary
  const binaryPath = findClientBinary(serverDir);
  if (!binaryPath) {
    overallSuccess = false;
    steps.push({ step: 'client', status: 'not_found', message: buildNotFoundMessage() });
    return { success: overallSuccess, steps, summary: formatSummary(steps) };
  }

  try {
    launchClient(binaryPath);
    steps.push({ step: 'client', status: 'launched', message: `Launched HITL client from ${binaryPath}` });
  } catch (error) {
    overallSuccess = false;
    steps.push({
      step: 'client',
      status: 'error',
      message: `Failed to launch client: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  return { success: overallSuccess, steps, summary: formatSummary(steps) };
}

/** Format step results into a human-readable summary. */
function formatSummary(steps: SetupStepResult[]): string {
  return steps.map((s) => `[${s.status.toUpperCase()}] ${s.step}: ${s.message}`).join('\n');
}
