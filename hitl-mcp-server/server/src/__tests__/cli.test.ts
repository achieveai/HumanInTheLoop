import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// --- Module-level mocks ---

// child_process: cli.ts must use a safe, non-shell API (execFileSync) to
// invoke `claude mcp add`, never execSync/exec with a concatenated string.
const mockExecFileSync = jest.fn<(...args: unknown[]) => string>();
jest.unstable_mockModule('child_process', () => ({
  execFileSync: mockExecFileSync,
  execSync: jest.fn(),
  spawn: jest.fn(),
}));

// fs/os: cli.ts's default host-setting merge delegates to host-settings.ts,
// which reads/writes ~/.claude/settings.json — mock the filesystem so the
// default CLI path can be exercised without touching a real home directory.
const mockExistsSync = jest.fn<(p: string) => boolean>();
const mockReadFileSync = jest.fn<(p: string, enc: string) => string>();
const mockWriteFileSync = jest.fn<(...args: unknown[]) => void>();
const mockMkdirSync = jest.fn<(...args: unknown[]) => void>();
const mockRenameSync = jest.fn<(from: string, to: string) => void>();
const mockUnlinkSync = jest.fn<(p: string) => void>();
jest.unstable_mockModule('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    mkdirSync: mockMkdirSync,
    renameSync: mockRenameSync,
    unlinkSync: mockUnlinkSync,
  };
});
jest.unstable_mockModule('os', () => {
  const actual = jest.requireActual<typeof import('os')>('os');
  return {
    ...actual,
    homedir: jest.fn(() => '/mock/home'),
  };
});

// Dynamically import the module under test AFTER mocks are registered.
const { performClaudeCodeInstall, buildClaudeMcpAddArgs } = await import('../cli.js');

describe('cli: hitl claude-code install', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
  });

  describe('buildClaudeMcpAddArgs', () => {
    it('registers a user-scoped stdio server launched via npx', () => {
      const args = buildClaudeMcpAddArgs();
      expect(args).toEqual([
        'mcp', 'add', 'hitl',
        '--scope', 'user',
        '--transport', 'stdio',
        '--',
        'npx', '-y', '@achieveai/hitl-mcp-server',
      ]);
    });

    it('never carries an --env flag (no auto-background env baked into registration)', () => {
      const args = buildClaudeMcpAddArgs();
      expect(args).not.toContain('--env');
      expect(args.some((a) => /auto.?launch|auto.?background/i.test(a))).toBe(false);
    });
  });

  describe('performClaudeCodeInstall', () => {
    it('registers and merges the global host setting on first install', () => {
      const runClaudeMcpAdd = jest.fn();
      const mergeGlobalHostSetting = jest.fn(() => ({ updated: true, path: '/mock/settings.json' }));

      const result = performClaudeCodeInstall({ runClaudeMcpAdd, mergeGlobalHostSetting });

      expect(runClaudeMcpAdd).toHaveBeenCalledWith(buildClaudeMcpAddArgs());
      expect(mergeGlobalHostSetting).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);
      expect(result.registered).toBe('added');
      expect(result.hostSetting).toEqual({ updated: true, path: '/mock/settings.json' });
      expect(result.restartInstruction.length).toBeGreaterThan(0);
    });

    it('is idempotent: an "already exists" registration failure is reported as success', () => {
      const runClaudeMcpAdd = jest.fn(() => {
        throw new Error('MCP server "hitl" already exists in user config');
      });
      const mergeGlobalHostSetting = jest.fn(() => ({ updated: false, path: '/mock/settings.json' }));

      const result = performClaudeCodeInstall({ runClaudeMcpAdd, mergeGlobalHostSetting });

      expect(result.success).toBe(true);
      expect(result.registered).toBe('already_registered');
      // Host setting should still be (re-)merged on a repeat install.
      expect(mergeGlobalHostSetting).toHaveBeenCalledTimes(1);
    });

    it('reports failure when claude mcp add fails for a reason other than "already exists"', () => {
      const runClaudeMcpAdd = jest.fn(() => {
        throw new Error('claude: command not found');
      });
      const mergeGlobalHostSetting = jest.fn();

      const result = performClaudeCodeInstall({ runClaudeMcpAdd, mergeGlobalHostSetting });

      expect(result.success).toBe(false);
      expect(result.registered).toBe('error');
      expect(result.message).toContain('command not found');
      // Do not attempt to merge host settings if registration truly failed.
      expect(mergeGlobalHostSetting).not.toHaveBeenCalled();
    });

    it('reports failure when merging global host settings throws, while preserving the registration outcome', () => {
      const runClaudeMcpAdd = jest.fn();
      const mergeGlobalHostSetting = jest.fn(() => {
        throw new Error('disk full');
      });

      const result = performClaudeCodeInstall({ runClaudeMcpAdd, mergeGlobalHostSetting });

      expect(result.success).toBe(false);
      expect(result.registered).toBe('added');
      expect(result.message).toContain('disk full');
    });

    it('always produces a restart instruction, even on failure', () => {
      const runClaudeMcpAdd = jest.fn(() => {
        throw new Error('boom');
      });
      const result = performClaudeCodeInstall({ runClaudeMcpAdd, mergeGlobalHostSetting: jest.fn() });
      expect(result.restartInstruction).toMatch(/restart/i);
    });

    it('by default runs the registration via execFileSync (no shell), passing argv as an array', () => {
      mockExecFileSync.mockReturnValue('');

      const result = performClaudeCodeInstall();

      expect(mockExecFileSync).toHaveBeenCalledTimes(1);
      const [command, args, options] = mockExecFileSync.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
      expect(command).toBe('claude');
      expect(Array.isArray(args)).toBe(true);
      expect(args).toEqual(buildClaudeMcpAddArgs());
      expect(options).toMatchObject({ stdio: 'pipe' });
      expect(result.success).toBe(true);
    });

    describe('default host-setting merge (real host-settings module)', () => {
      it('writes CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS="0" to settings.json on first install', () => {
        mockExecFileSync.mockReturnValue('');
        mockExistsSync.mockReturnValue(false);

        const result = performClaudeCodeInstall();

        expect(result.hostSetting.updated).toBe(true);
        expect(result.hostSetting.path).toContain('settings.json');
        expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
        const [, contents] = mockWriteFileSync.mock.calls[0] as unknown as [string, string];
        const parsed = JSON.parse(contents);
        expect(parsed.env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS).toBe('0');
        expect(mockRenameSync).toHaveBeenCalledTimes(1);
      });

      it('preserves unrelated existing settings keys when installing', () => {
        mockExecFileSync.mockReturnValue('');
        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue(
          JSON.stringify({ theme: 'dark', permissions: { allow: ['Bash'] } })
        );

        const result = performClaudeCodeInstall();

        expect(result.hostSetting.updated).toBe(true);
        const [, contents] = mockWriteFileSync.mock.calls[0] as unknown as [string, string];
        const parsed = JSON.parse(contents);
        expect(parsed.theme).toBe('dark');
        expect(parsed.permissions).toEqual({ allow: ['Bash'] });
        expect(parsed.env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS).toBe('0');
      });

      it('is idempotent: a repeat install after the setting is already applied performs no write', () => {
        mockExecFileSync.mockReturnValue('');
        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue(
          JSON.stringify({ env: { CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: '0' } })
        );

        const result = performClaudeCodeInstall();

        expect(result.hostSetting.updated).toBe(false);
        expect(mockWriteFileSync).not.toHaveBeenCalled();
      });
    });
  });
});
