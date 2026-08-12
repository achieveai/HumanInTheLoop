import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import path from 'path';

// --- Module-level mocks ---

// fs
const mockExistsSync = jest.fn<(p: string) => boolean>();
const mockReadFileSync = jest.fn<(p: string, enc: string) => string>();
jest.unstable_mockModule('fs', () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
}));

// os
jest.unstable_mockModule('os', () => ({
  homedir: jest.fn(() => '/mock/home'),
}));

// Dynamically import the module under test AFTER mocks are registered
const {
  getHostSettingsPath,
  readHostSettings,
  mergeAutoBackgroundSetting,
  detectAutoBackgroundStatus,
  buildAutoBackgroundRemediationText,
  AUTO_BACKGROUND_ENV_KEY,
  AUTO_BACKGROUND_TARGET_VALUE,
} = await import('../host-settings.js');

describe('host-settings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ---- getHostSettingsPath ----
  describe('getHostSettingsPath', () => {
    it('locates ~/.claude/settings.json under the home directory', () => {
      const result = getHostSettingsPath();
      expect(result).toBe(path.join('/mock/home', '.claude', 'settings.json'));
    });
  });

  // ---- readHostSettings ----
  describe('readHostSettings', () => {
    it('returns an empty object when the file does not exist', () => {
      mockExistsSync.mockReturnValue(false);
      expect(readHostSettings('/mock/home/.claude/settings.json')).toEqual({});
    });

    it('returns an empty object when the file is empty', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('   ');
      expect(readHostSettings('/mock/home/.claude/settings.json')).toEqual({});
    });

    it('parses existing JSON content, preserving all keys', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ theme: 'dark', permissions: { allow: ['Bash'] }, env: { FOO: 'bar' } })
      );
      expect(readHostSettings('/mock/home/.claude/settings.json')).toEqual({
        theme: 'dark',
        permissions: { allow: ['Bash'] },
        env: { FOO: 'bar' },
      });
    });

    it('throws on malformed JSON rather than silently discarding the file', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('{ not valid json');
      expect(() => readHostSettings('/mock/home/.claude/settings.json')).toThrow();
    });
  });

  // ---- mergeAutoBackgroundSetting ----
  describe('mergeAutoBackgroundSetting', () => {
    it('adds the env key to an empty settings object', () => {
      const result = mergeAutoBackgroundSetting({});
      expect(result).toEqual({ env: { [AUTO_BACKGROUND_ENV_KEY]: AUTO_BACKGROUND_TARGET_VALUE } });
    });

    it('preserves all existing top-level keys', () => {
      const existing = { theme: 'dark', permissions: { allow: ['Bash'] } };
      const result = mergeAutoBackgroundSetting(existing);
      expect(result).toEqual({
        theme: 'dark',
        permissions: { allow: ['Bash'] },
        env: { [AUTO_BACKGROUND_ENV_KEY]: AUTO_BACKGROUND_TARGET_VALUE },
      });
    });

    it('preserves all existing env keys alongside the new one', () => {
      const existing = { env: { OTHER_VAR: 'keep-me', ANOTHER: '123' } };
      const result = mergeAutoBackgroundSetting(existing);
      expect(result).toEqual({
        env: {
          OTHER_VAR: 'keep-me',
          ANOTHER: '123',
          [AUTO_BACKGROUND_ENV_KEY]: AUTO_BACKGROUND_TARGET_VALUE,
        },
      });
    });

    it('overwrites a stale value for the same key with the target value', () => {
      const existing = { env: { [AUTO_BACKGROUND_ENV_KEY]: '30000' } };
      const result = mergeAutoBackgroundSetting(existing);
      expect((result.env as Record<string, unknown>)[AUTO_BACKGROUND_ENV_KEY]).toBe(
        AUTO_BACKGROUND_TARGET_VALUE
      );
    });

    it('is idempotent — merging its own output twice yields the same result', () => {
      const existing = { theme: 'dark', env: { OTHER_VAR: 'keep-me' } };
      const once = mergeAutoBackgroundSetting(existing);
      const twice = mergeAutoBackgroundSetting(once);
      expect(twice).toEqual(once);
    });

    it('does not mutate the input object', () => {
      const existing = { env: { OTHER_VAR: 'keep-me' } };
      const snapshotBefore = JSON.parse(JSON.stringify(existing));
      mergeAutoBackgroundSetting(existing);
      expect(existing).toEqual(snapshotBefore);
    });
  });

  // ---- detectAutoBackgroundStatus ----
  describe('detectAutoBackgroundStatus', () => {
    it('reports active via inherited env when the process env already has the target value', () => {
      mockExistsSync.mockReturnValue(false);
      const status = detectAutoBackgroundStatus(
        { [AUTO_BACKGROUND_ENV_KEY]: AUTO_BACKGROUND_TARGET_VALUE } as NodeJS.ProcessEnv,
        '/mock/home/.claude/settings.json'
      );
      expect(status.active).toBe(true);
      expect(status.activeInEnv).toBe(true);
      expect(status.configuredForRestart).toBe(false);
    });

    it('reports active via settings.json when configured for the next restart', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ env: { [AUTO_BACKGROUND_ENV_KEY]: AUTO_BACKGROUND_TARGET_VALUE } })
      );
      const status = detectAutoBackgroundStatus({} as NodeJS.ProcessEnv, '/mock/home/.claude/settings.json');
      expect(status.active).toBe(true);
      expect(status.activeInEnv).toBe(false);
      expect(status.configuredForRestart).toBe(true);
    });

    it('reports inactive when neither the env nor settings.json has the target value', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({ env: { OTHER_VAR: 'keep-me' } }));
      const status = detectAutoBackgroundStatus(
        { [AUTO_BACKGROUND_ENV_KEY]: '30000' } as NodeJS.ProcessEnv,
        '/mock/home/.claude/settings.json'
      );
      expect(status.active).toBe(false);
      expect(status.activeInEnv).toBe(false);
      expect(status.configuredForRestart).toBe(false);
    });

    it('reports inactive (not throwing) when settings.json is malformed', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('{ not valid json');
      const status = detectAutoBackgroundStatus({} as NodeJS.ProcessEnv, '/mock/home/.claude/settings.json');
      expect(status.active).toBe(false);
    });

    it('reports inactive when the settings.json file does not exist and env is unset', () => {
      mockExistsSync.mockReturnValue(false);
      const status = detectAutoBackgroundStatus({} as NodeJS.ProcessEnv, '/mock/home/.claude/settings.json');
      expect(status.active).toBe(false);
      expect(status.activeInEnv).toBe(false);
      expect(status.configuredForRestart).toBe(false);
    });
  });

  // ---- buildAutoBackgroundRemediationText ----
  describe('buildAutoBackgroundRemediationText', () => {
    it('mentions the env key, the target value, and the settings path', () => {
      const text = buildAutoBackgroundRemediationText('/mock/home/.claude/settings.json');
      expect(text).toContain(AUTO_BACKGROUND_ENV_KEY);
      expect(text).toContain(AUTO_BACKGROUND_TARGET_VALUE);
      expect(text).toContain('/mock/home/.claude/settings.json');
    });

    it('is reusable — deterministic for the same input', () => {
      const first = buildAutoBackgroundRemediationText('/mock/home/.claude/settings.json');
      const second = buildAutoBackgroundRemediationText('/mock/home/.claude/settings.json');
      expect(first).toBe(second);
    });
  });
});
