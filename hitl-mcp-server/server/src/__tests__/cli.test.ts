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

// Dynamically import the module under test AFTER mocks are registered.
const { performClaudeCodeInstall, buildClaudeMcpAddArgs } = await import('../cli.js');

describe('cli: hitl claude-code install', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
      // The default host-setting merge is a safe placeholder until the
      // dedicated host-settings module is wired in (see cli.ts).
      expect(result.hostSetting).toEqual({ updated: false, path: '' });
      expect(result.success).toBe(true);
    });
  });
});
