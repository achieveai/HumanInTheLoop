import { existsSync, chmodSync, accessSync, constants } from 'fs';
import { execSync, spawn } from 'child_process';
import { homedir, arch } from 'os';
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
 * Get the platform-specific subdirectory name for bundled binaries.
 * Maps Node.js platform/arch to the artifact names used in CI.
 */
function getBundledPlatformDir(): string {
  const platform = process.platform;
  const cpuArch = arch();

  if (platform === 'win32') return 'windows-x64';
  if (platform === 'linux') return 'linux-x64';
  if (platform === 'darwin') {
    return cpuArch === 'arm64' ? 'macos-arm64' : 'macos-x64';
  }
  return 'unknown';
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
 * Priority: bundled with npm package > dev build > release build > ~/.hitl/
 *
 * @param serverDir - The directory where the compiled server JS lives (e.g. server/dist/)
 */
export function findClientBinary(serverDir: string): string | null {
  const binaryName = process.platform === 'win32' ? 'hitl-client.exe' : 'hitl-client';
  const platformDir = getBundledPlatformDir();

  const candidates = [
    // Bundled with npm package (dist/bin/{platform}/hitl-client)
    path.resolve(serverDir, 'bin', platformDir, binaryName),
    // Dev build (relative to server dist → repo root → client)
    path.resolve(serverDir, '..', '..', 'client', 'src-tauri', 'target', 'debug', binaryName),
    // Release build
    path.resolve(serverDir, '..', '..', 'client', 'src-tauri', 'target', 'release', binaryName),
    // Installed location in user home
    path.join(homedir(), '.hitl', binaryName),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      // Ensure executable permission on Unix
      if (process.platform !== 'win32') {
        try { chmodSync(candidate, 0o755); } catch { /* best effort */ }
      }
      return candidate;
    }
  }

  return null;
}

/**
 * Launch the client binary as a fully detached background process.
 *
 * The `'error'` listener is not optional. Node reports a failed exec (ENOENT,
 * EACCES) by emitting `'error'` asynchronously, and an unhandled `'error'` on
 * an EventEmitter is rethrown as an uncaught exception — which, from inside a
 * tool call, kills the whole MCP server instead of returning a message the
 * agent can act on (H9).
 */
export function launchClient(binaryPath: string): void {
  const child = spawn(binaryPath, [], {
    detached: true,
    stdio: 'ignore',
  });
  child.on('error', (err) => {
    console.error(`HITL client at ${binaryPath} failed to start: ${err.message}`);
  });
  child.unref();
}

/** Outcome of ensureClientRunning — the caller must not publish when `ok` is false. */
export interface ClientRunningResult {
  ok: boolean;
  /** Why the client is unavailable. Present only when `ok` is false. */
  reason?: string;
}

/**
 * Ensure the HITL client is running. Finds and launches it if needed.
 *
 * Returns the outcome rather than only logging it: with timeouts removed, a
 * caller that publishes to a topic nobody is subscribed to blocks forever and
 * the human never sees anything (A-10). Both "binary not found" and "launch
 * failed" must reach the agent as an error before anything is published.
 */
export function ensureClientRunning(serverDir: string): ClientRunningResult {
  const binaryName = process.platform === 'win32' ? 'hitl-client.exe' : 'hitl-client';

  if (isProcessRunning(binaryName)) {
    return { ok: true };
  }

  const binaryPath = findClientBinary(serverDir);
  if (!binaryPath) {
    return { ok: false, reason: buildNotFoundMessage(serverDir) };
  }

  try {
    // Checked synchronously so an unusable binary becomes a returned reason
    // rather than an async 'error' event that arrives after this function has
    // already told the caller everything was fine.
    accessSync(binaryPath, constants.X_OK);
    launchClient(binaryPath);
    console.error(`Auto-launched HITL client from ${binaryPath}`);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: `Failed to launch the HITL client at ${binaryPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Build a user-friendly "not found" message listing the paths that were searched.
 */
function buildNotFoundMessage(serverDir: string): string {
  const binaryName = process.platform === 'win32' ? 'hitl-client.exe' : 'hitl-client';
  const platformDir = getBundledPlatformDir();
  return [
    `HITL client binary not found. Searched locations:`,
    `  - ${path.resolve(serverDir, 'bin', platformDir, binaryName)} (bundled)`,
    `  - <repo>/client/src-tauri/target/debug/${binaryName}`,
    `  - <repo>/client/src-tauri/target/release/${binaryName}`,
    `  - ~/.hitl/${binaryName}`,
    ``,
    `Install the client from GitHub Releases:`,
    `  https://github.com/achieveai/HumanInTheLoop/releases`,
    `Or build from source: cd client && npm run build`,
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
    steps.push({ step: 'client', status: 'not_found', message: buildNotFoundMessage(serverDir) });
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
