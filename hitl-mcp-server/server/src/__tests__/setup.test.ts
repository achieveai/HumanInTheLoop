import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import path from 'path';
import type { SetupResult } from '../setup.js';

// --- Module-level mocks ---

// fs
const mockExistsSync = jest.fn<(p: string) => boolean>();
const mockAccessSync = jest.fn<(p: string, mode?: number) => void>();
jest.unstable_mockModule('fs', () => ({
  existsSync: mockExistsSync,
  accessSync: mockAccessSync,
  constants: { X_OK: 1 },
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
  chmodSync: jest.fn(),
}));

// child_process
const mockExecSync = jest.fn<(...args: unknown[]) => string>();
type FakeChild = { unref: () => void; on: (event: string, cb: (err: Error) => void) => FakeChild };
const mockSpawn = jest.fn<(...args: unknown[]) => FakeChild>();
jest.unstable_mockModule('child_process', () => ({
  execSync: mockExecSync,
  spawn: mockSpawn,
}));

// os
jest.unstable_mockModule('os', () => ({
  homedir: jest.fn(() => '/mock/home'),
  hostname: jest.fn(() => 'mock-host'),
  arch: jest.fn(() => 'x64'),
}));

// config
const mockGetConfigPath = jest.fn<() => string>();
const mockGenerateDefaultConfig = jest.fn<() => Record<string, unknown>>();
const mockSaveConfig = jest.fn<(config: unknown) => void>();
jest.unstable_mockModule('../config.js', () => ({
  getConfigPath: mockGetConfigPath,
  generateDefaultConfig: mockGenerateDefaultConfig,
  saveConfig: mockSaveConfig,
  loadConfig: jest.fn(),
}));

// host-settings
type AutoBackgroundStatusMock = {
  active: boolean;
  activeInEnv: boolean;
  configuredForRestart: boolean;
};
const mockDetectAutoBackgroundStatus = jest.fn<() => AutoBackgroundStatusMock>();
const mockBuildAutoBackgroundRemediationText = jest.fn<() => string>();
jest.unstable_mockModule('../host-settings.js', () => ({
  detectAutoBackgroundStatus: mockDetectAutoBackgroundStatus,
  buildAutoBackgroundRemediationText: mockBuildAutoBackgroundRemediationText,
  AUTO_BACKGROUND_ENV_KEY: 'CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS',
  AUTO_BACKGROUND_TARGET_VALUE: '0',
}));

// Dynamically import the module under test AFTER mocks are registered
const { performSetup, isProcessRunning, findClientBinary, launchClient } = await import('../setup.js');

describe('setup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetConfigPath.mockReturnValue('/mock/home/.hitl/config.json');
    mockGenerateDefaultConfig.mockReturnValue({ topicId: 'hitl-test-uuid' });
    // Default: guard already active, so existing performSetup tests that
    // don't care about this step see a clean, non-warning result.
    mockDetectAutoBackgroundStatus.mockReturnValue({
      active: true,
      activeInEnv: true,
      configuredForRestart: false,
    });
    mockBuildAutoBackgroundRemediationText.mockReturnValue('mock remediation text');
  });

  // ---- isProcessRunning ----
  describe('isProcessRunning', () => {
    it('returns true when tasklist finds the process (win32)', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32' });

      mockExecSync.mockReturnValue('hitl-client.exe  1234 Console  1  10,000 K');
      expect(isProcessRunning('hitl-client.exe')).toBe(true);

      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    it('returns false when tasklist does not find the process (win32)', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32' });

      mockExecSync.mockReturnValue('INFO: No tasks are running which match the specified criteria.');
      expect(isProcessRunning('hitl-client.exe')).toBe(false);

      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    it('returns false when execSync throws', () => {
      mockExecSync.mockImplementation(() => { throw new Error('command failed'); });
      expect(isProcessRunning('hitl-client.exe')).toBe(false);
    });
  });

  // ---- findClientBinary ----
  describe('findClientBinary', () => {
    it('returns the first existing binary path', () => {
      // Only the second candidate (release) exists
      mockExistsSync.mockImplementation((p: string) =>
        p.includes('release')
      );

      const result = findClientBinary('/mock/server/dist');
      expect(result).toContain('release');
      expect(result).not.toBeNull();
    });

    it('returns null when no binary is found', () => {
      mockExistsSync.mockReturnValue(false);
      const result = findClientBinary('/mock/server/dist');
      expect(result).toBeNull();
    });

    it('prefers debug build over release when both exist', () => {
      // Both dev builds exist, but not the bundled binary (highest priority)
      mockExistsSync.mockImplementation((p: string) =>
        p.includes('debug') || p.includes('release')
      );
      const result = findClientBinary('/mock/server/dist');
      expect(result).toContain('debug');
    });

    it('prefers the bundled binary over all other locations', () => {
      mockExistsSync.mockReturnValue(true); // every candidate exists
      const result = findClientBinary('/mock/server/dist');
      // Only the bundled candidate lives under a "bin" dir; dev builds use
      // "target/{debug,release}" and the home install uses ".hitl".
      expect(result).toContain('bin');
      expect(result).not.toContain('target');
      expect(result).not.toContain('.hitl');
    });

    it('looks for a dev build in the cargo workspace target dir', () => {
      // The cases above match on the substrings "debug"/"release"/"target",
      // which every plausible target path contains — so they stayed green
      // while the prefix was wrong for months. `client/src-tauri` is a member
      // of the hitl-mcp-server workspace, not a workspace root, so cargo writes
      // to <workspace>/target/, one level up from server/dist. Assert the whole
      // resolved path; a substring cannot tell the two apart.
      const binaryName = process.platform === 'win32' ? 'hitl-client.exe' : 'hitl-client';
      const searched: string[] = [];
      mockExistsSync.mockImplementation((p: string) => {
        searched.push(p);
        return false;
      });

      findClientBinary(path.join('/mock/workspace', 'server', 'dist'));

      expect(searched).toContain(path.resolve('/mock/workspace', 'target', 'debug', binaryName));
      expect(searched).toContain(path.resolve('/mock/workspace', 'target', 'release', binaryName));
      expect(searched.some((p) => p.includes('src-tauri'))).toBe(false);
    });
  });

  // ---- launchClient ----
  describe('launchClient', () => {
    it('spawns a detached process and unrefs it', () => {
      const mockUnref = jest.fn();
      const mockOn = jest.fn();
      mockSpawn.mockReturnValue({ unref: mockUnref, on: mockOn } as unknown as FakeChild);

      launchClient('/path/to/hitl-client');

      expect(mockSpawn).toHaveBeenCalledWith('/path/to/hitl-client', [], {
        detached: true,
        stdio: 'ignore',
      });
      expect(mockUnref).toHaveBeenCalled();
    });

    it('handles the async spawn error rather than letting it kill the server (H9)', () => {
      // Node reports a failed exec by emitting 'error' asynchronously. With no
      // listener that is rethrown as an uncaught exception, which from inside a
      // tool call takes the whole MCP server down.
      let emitError: ((err: Error) => void) | undefined;
      mockSpawn.mockReturnValue({
        unref: jest.fn(),
        on: ((event: string, cb: (err: Error) => void) => {
          if (event === 'error') emitError = cb;
          return undefined as unknown as FakeChild;
        }) as FakeChild['on'],
      } as unknown as FakeChild);

      launchClient('/path/to/hitl-client');

      expect(emitError).toBeDefined();
      expect(() => emitError?.(new Error('spawn ENOENT'))).not.toThrow();
    });
  });

  // ---- performSetup ----
  describe('performSetup', () => {
    it('reports config ok and client already running', async () => {
      // Config exists
      mockExistsSync.mockImplementation((p: string) =>
        p.endsWith('config.json')
      );
      // Client is running (win32 tasklist output)
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32' });
      mockExecSync.mockReturnValue('hitl-client.exe  1234 Console');

      const result: SetupResult = await performSetup('/mock/server/dist');

      expect(result.success).toBe(true);
      expect(result.steps).toHaveLength(3);
      expect(result.steps[0].status).toBe('ok');
      const clientStep = result.steps.find((s) => s.step === 'client');
      expect(clientStep?.status).toBe('already_running');

      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    it('creates config when missing', async () => {
      // Config does NOT exist, binary does NOT exist, client NOT running
      mockExistsSync.mockReturnValue(false);
      mockExecSync.mockImplementation(() => { throw new Error('not found'); });

      const result = await performSetup('/mock/server/dist');

      expect(mockGenerateDefaultConfig).toHaveBeenCalled();
      expect(mockSaveConfig).toHaveBeenCalledWith({ topicId: 'hitl-test-uuid' });
      expect(result.steps[0].status).toBe('created');
    });

    it('reports error when config creation fails', async () => {
      mockExistsSync.mockReturnValue(false);
      mockExecSync.mockImplementation(() => { throw new Error('not found'); });
      mockSaveConfig.mockImplementation(() => { throw new Error('disk full'); });

      const result = await performSetup('/mock/server/dist');

      expect(result.success).toBe(false);
      expect(result.steps[0].status).toBe('error');
      expect(result.steps[0].message).toContain('disk full');
    });

    it('reports not_found when binary is missing and client is not running', async () => {
      // Config exists but no binary and no running process
      mockExistsSync.mockImplementation((p: string) =>
        p.endsWith('config.json')
      );
      mockExecSync.mockImplementation(() => { throw new Error('not found'); });

      const result = await performSetup('/mock/server/dist');

      expect(result.success).toBe(false);
      const clientStep = result.steps.find((s) => s.step === 'client');
      expect(clientStep?.status).toBe('not_found');
      expect(clientStep?.message).toContain('not found');
    });

    it('launches client when binary is found and client is not running', async () => {
      const mockUnref = jest.fn();
      mockSpawn.mockReturnValue({ unref: mockUnref, on: jest.fn() } as unknown as FakeChild);

      // Config exists, binary exists at release path, client not running
      mockExistsSync.mockImplementation((p: string) =>
        p.endsWith('config.json') || p.includes('release')
      );
      mockExecSync.mockImplementation(() => { throw new Error('not found'); });

      const result = await performSetup('/mock/server/dist');

      expect(result.success).toBe(true);
      const clientStep = result.steps.find((s) => s.step === 'client');
      expect(clientStep?.status).toBe('launched');
      expect(mockSpawn).toHaveBeenCalled();
      expect(mockUnref).toHaveBeenCalled();
    });

    it('reports error when launch fails', async () => {
      // Config exists, binary exists, but spawn throws
      mockExistsSync.mockReturnValue(true);
      mockExecSync.mockImplementation(() => { throw new Error('not found'); });
      mockSpawn.mockImplementation(() => { throw new Error('ENOENT'); });

      const result = await performSetup('/mock/server/dist');

      expect(result.success).toBe(false);
      const clientStep = result.steps.find((s) => s.step === 'client');
      expect(clientStep?.status).toBe('error');
      expect(clientStep?.message).toContain('ENOENT');
    });

    // ---- auto-background-env diagnostic step ----
    describe('auto-background-env diagnostic step', () => {
      it('reports ok when the guard is already active', async () => {
        mockExistsSync.mockReturnValue(true); // config exists, client not running below
        mockExecSync.mockImplementation(() => { throw new Error('not found'); });
        mockDetectAutoBackgroundStatus.mockReturnValue({
          active: true,
          activeInEnv: true,
          configuredForRestart: false,
        });

        const result = await performSetup('/mock/server/dist');

        const step = result.steps.find((s) => s.step === 'auto-background-env');
        expect(step?.status).toBe('ok');
        expect(mockBuildAutoBackgroundRemediationText).not.toHaveBeenCalled();
      });

      it('reports warning with remediation text when the guard is inactive, without failing setup', async () => {
        // Config exists, client already running — the only failure mode left
        // to isolate is the diagnostic step itself.
        mockExistsSync.mockImplementation((p: string) => p.endsWith('config.json'));
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'win32' });
        mockExecSync.mockReturnValue('hitl-client.exe  1234 Console');

        mockDetectAutoBackgroundStatus.mockReturnValue({
          active: false,
          activeInEnv: false,
          configuredForRestart: false,
        });
        mockBuildAutoBackgroundRemediationText.mockReturnValue('mock remediation text');

        const result = await performSetup('/mock/server/dist');

        const step = result.steps.find((s) => s.step === 'auto-background-env');
        expect(step?.status).toBe('warning');
        expect(step?.message).toBe('mock remediation text');
        // Non-fatal: overall success is unaffected by this diagnostic alone.
        expect(result.success).toBe(true);

        Object.defineProperty(process, 'platform', { value: originalPlatform });
      });

      it('never writes to host settings as part of default setup', async () => {
        mockExistsSync.mockImplementation((p: string) => p.endsWith('config.json'));
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'win32' });
        mockExecSync.mockReturnValue('hitl-client.exe  1234 Console');
        mockDetectAutoBackgroundStatus.mockReturnValue({
          active: false,
          activeInEnv: false,
          configuredForRestart: false,
        });

        await performSetup('/mock/server/dist');

        // setup.ts must only read/diagnose — never call writeFileSync itself
        // for host settings. The only fs writer available to it is the
        // (mocked) writeFileSync from the fs module, which performSetup
        // should never invoke for this step.
        const mockWriteFileSync = (await import('fs')).writeFileSync as unknown as jest.Mock;
        expect(mockWriteFileSync).not.toHaveBeenCalled();

        Object.defineProperty(process, 'platform', { value: originalPlatform });
      });
    });
  });
});
