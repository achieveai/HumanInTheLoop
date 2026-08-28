import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// --- Module-level mocks ---
// These cases are about the shape of the parsed config, not where it lives, so
// os/fs are mocked the same way host-settings.test.ts/cli.test.ts do.
// config.ts now resolves its directory per call and honors HITL_HOME, matching
// ntfy-transport.ts, snapshot-store.ts and the Rust `hitl_dir()` — that
// resolution is covered against the real filesystem in config-paths.test.ts.

const mockExistsSync = jest.fn<(p: string) => boolean>();
const mockReadFileSync = jest.fn<(p: string, enc: string) => string>();
const mockWriteFileSync = jest.fn<(...args: unknown[]) => void>();
const mockMkdirSync = jest.fn<(...args: unknown[]) => void>();
const mockCopyFileSync = jest.fn<(src: string, dest: string) => void>();
jest.unstable_mockModule('fs', () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
  mkdirSync: mockMkdirSync,
  copyFileSync: mockCopyFileSync,
}));
jest.unstable_mockModule('os', () => ({
  homedir: jest.fn(() => '/mock/home'),
  hostname: jest.fn(() => 'test-host'),
}));

// Dynamically import the module under test AFTER mocks are registered.
const { loadConfig, generateDefaultConfig, saveConfig, getConfigPath } = await import('../config.js');

/** Minimal valid config JSON — loadConfig throws without a topicId. */
function configJson(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ topicId: 'hitl-test-topic', ...extra });
}

describe('config: identityEnabled', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
  });

  describe('loadConfig', () => {
    it('defaults identityEnabled to true when the key is absent', () => {
      mockReadFileSync.mockReturnValue(configJson());
      expect(loadConfig().identityEnabled).toBe(true);
    });

    it('respects an explicit identityEnabled: true', () => {
      mockReadFileSync.mockReturnValue(configJson({ identityEnabled: true }));
      expect(loadConfig().identityEnabled).toBe(true);
    });

    it('respects an explicit identityEnabled: false (not defeated by a naive || default)', () => {
      mockReadFileSync.mockReturnValue(configJson({ identityEnabled: false }));
      expect(loadConfig().identityEnabled).toBe(false);
    });
  });

  describe('generateDefaultConfig', () => {
    it('defaults identityEnabled to true', () => {
      expect(generateDefaultConfig().identityEnabled).toBe(true);
    });
  });
});

describe('config: saveConfig keeps the previous config', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('copies the existing config aside before overwriting it', () => {
    mockExistsSync.mockReturnValue(true);

    saveConfig(generateDefaultConfig());

    expect(mockCopyFileSync).toHaveBeenCalledWith(
      getConfigPath(),
      `${getConfigPath()}.bak`
    );
  });

  it('writes no backup on a first run, when there is nothing to lose yet', () => {
    mockExistsSync.mockReturnValue(false);

    saveConfig(generateDefaultConfig());

    expect(mockCopyFileSync).not.toHaveBeenCalled();
    expect(mockWriteFileSync).toHaveBeenCalled();
  });

  it('still saves the new config when the backup cannot be written', () => {
    mockExistsSync.mockReturnValue(true);
    mockCopyFileSync.mockImplementation(() => {
      throw new Error('EACCES: read-only volume');
    });

    expect(() => saveConfig(generateDefaultConfig())).not.toThrow();
    expect(mockWriteFileSync).toHaveBeenCalled();
  });
});
