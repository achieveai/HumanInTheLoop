#!/usr/bin/env node

import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { loadConfig, saveConfig, generateDefaultConfig, getConfigPath } from './config.js';
import { findClientBinary, launchClient } from './setup.js';
import { applyAutoBackgroundSetting } from './host-settings.js';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const HELP = `
hitl — Human-in-the-Loop MCP CLI

Usage:
  hitl init                Create a new config at ~/.hitl/config.json
  hitl config show         Print the current config
  hitl config set-topic <id>  Update the topic ID
  hitl test                Send a test question through ntfy
  hitl client              Launch the HITL desktop client app
  hitl claude-code install Register HITL as a Claude Code MCP server (user scope)
  hitl help                Show this help message
`;

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'init':
      return cmdInit();
    case 'config':
      return cmdConfig(args.slice(1));
    case 'test':
      return cmdTest();
    case 'client':
      return cmdClient();
    case 'claude-code':
      return cmdClaudeCode(args.slice(1));
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      console.log(HELP);
      return;
    default:
      console.error(`Unknown command: ${command}`);
      console.log(HELP);
      process.exit(1);
  }
}

function cmdInit() {
  try {
    const existing = loadConfig();

    // Backfill encryptionKey if missing
    if (!existing.encryptionKey) {
      existing.encryptionKey = crypto.randomBytes(32).toString('hex');
      saveConfig(existing);
      console.log(`Config at ${getConfigPath()} updated with encryption key.`);
      console.log(`Encryption key: ${existing.encryptionKey}`);
      console.log(`\nCopy this key to ~/.hitl/config.json on your other machines.`);
      return;
    }

    console.log(`Config already exists at ${getConfigPath()}`);
    console.log('Use "hitl config show" to view it, or delete the file to reinitialize.');
    return;
  } catch {
    // Config doesn't exist — this is expected
  }

  const config = generateDefaultConfig();
  saveConfig(config);
  console.log(`Created config at ${getConfigPath()}`);
  console.log(`\nYour topic ID: ${config.topicId}`);
  if (config.encryptionKey) {
    console.log(`Encryption key: ${config.encryptionKey}`);
  }
  console.log(`\nCopy this config to ~/.hitl/config.json on your other machines.`);
  console.log(`Or run: hitl config set-topic ${config.topicId}`);
}

function cmdConfig(args: string[]) {
  const subcommand = args[0];

  switch (subcommand) {
    case 'show': {
      const config = loadConfig();
      console.log(JSON.stringify(config, null, 2));
      console.log(`\nConfig file: ${getConfigPath()}`);
      return;
    }
    case 'set-topic': {
      const topicId = args[1];
      if (!topicId) {
        console.error('Usage: hitl config set-topic <topic-id>');
        process.exit(1);
      }
      const config = loadConfig();
      config.topicId = topicId;
      saveConfig(config);
      console.log(`Topic ID updated to: ${topicId}`);
      return;
    }
    default:
      console.error(`Unknown config subcommand: ${subcommand}`);
      console.log('Available: show, set-topic');
      process.exit(1);
  }
}

function cmdClient() {
  const serverDir = dirname(fileURLToPath(import.meta.url));
  const binaryPath = findClientBinary(serverDir);

  if (!binaryPath) {
    console.error('HITL client binary not found for this platform.');
    console.error('Install it from GitHub Releases:');
    console.error('  https://github.com/achieveai/HumanInTheLoop/releases');
    console.error('Or build from source: cd client && npm run build');
    process.exit(1);
  }

  launchClient(binaryPath);
  console.log(`HITL Client launched from ${binaryPath}`);
}

// --- claude-code install ---

const CLAUDE_CODE_MCP_NAME = 'hitl';
const CLAUDE_CODE_MCP_PACKAGE = '@achieveai/hitl-mcp-server';
const CLAUDE_CODE_RESTART_INSTRUCTION =
  'Restart Claude Code (or start a new session) for the HITL MCP server to become available.';

/** Result of merging HITL's entry into a host's global (user-level) settings. */
export interface HostSettingMergeResult {
  updated: boolean;
  path: string;
}

/**
 * Merge HITL's entry into Claude Code's global user-level settings
 * (~/.claude/settings.json), setting CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS="0"
 * so Claude Code never auto-backgrounds a blocking HITL tool call before the
 * human gets a chance to respond. Delegates to host-settings.ts, which
 * preserves every unrelated key and is idempotent.
 */
function defaultMergeGlobalHostSetting(): HostSettingMergeResult {
  return applyAutoBackgroundSetting();
}

/** Injectable dependencies for {@link performClaudeCodeInstall}, for testing. */
export interface ClaudeCodeInstallDeps {
  runClaudeMcpAdd: (args: string[]) => void;
  mergeGlobalHostSetting: () => HostSettingMergeResult;
}

export interface ClaudeCodeInstallResult {
  success: boolean;
  registered: 'added' | 'already_registered' | 'error';
  message: string;
  hostSetting: HostSettingMergeResult;
  restartInstruction: string;
}

/**
 * Build the argv for `claude mcp add`, registering HITL as a user-scoped
 * stdio MCP server launched via npx. Deliberately carries no `--env` flags:
 * any "auto-launch client in the background" behavior belongs in global host
 * settings (merged separately via mergeGlobalHostSetting), not baked into
 * this per-registration command line.
 */
export function buildClaudeMcpAddArgs(): string[] {
  return [
    'mcp', 'add', CLAUDE_CODE_MCP_NAME,
    '--scope', 'user',
    '--transport', 'stdio',
    '--',
    'npx', '-y', CLAUDE_CODE_MCP_PACKAGE,
  ];
}

function defaultRunClaudeMcpAdd(args: string[]): void {
  // execFileSync: argv passed as an array, no shell involved — safe against
  // shell injection, unlike execSync/exec with a concatenated string.
  execFileSync('claude', args, { stdio: 'pipe', encoding: 'utf-8' });
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const withStreams = err as Error & { stderr?: string | Buffer; stdout?: string | Buffer };
    const parts = [withStreams.message, withStreams.stderr, withStreams.stdout]
      .filter((p): p is string | Buffer => Boolean(p))
      .map((p) => p.toString());
    return parts.join('\n');
  }
  return String(err);
}

/**
 * Register HITL as a Claude Code MCP server and merge the global host
 * setting. Idempotent: re-running after a prior successful install reports
 * `registered: 'already_registered'` (success) rather than an error.
 */
export function performClaudeCodeInstall(
  deps: ClaudeCodeInstallDeps = {
    runClaudeMcpAdd: defaultRunClaudeMcpAdd,
    mergeGlobalHostSetting: defaultMergeGlobalHostSetting,
  }
): ClaudeCodeInstallResult {
  let registered: 'added' | 'already_registered' = 'added';
  let message = `Registered "${CLAUDE_CODE_MCP_NAME}" as a user-scoped Claude Code MCP server.`;

  try {
    deps.runClaudeMcpAdd(buildClaudeMcpAddArgs());
  } catch (err) {
    const text = errorText(err);
    if (/already exists/i.test(text)) {
      registered = 'already_registered';
      message = `"${CLAUDE_CODE_MCP_NAME}" is already registered as a Claude Code MCP server.`;
    } else {
      return {
        success: false,
        registered: 'error',
        message: `Failed to register "${CLAUDE_CODE_MCP_NAME}" with Claude Code: ${text}`,
        hostSetting: { updated: false, path: '' },
        restartInstruction: CLAUDE_CODE_RESTART_INSTRUCTION,
      };
    }
  }

  try {
    const hostSetting = deps.mergeGlobalHostSetting();
    return {
      success: true,
      registered,
      message,
      hostSetting,
      restartInstruction: CLAUDE_CODE_RESTART_INSTRUCTION,
    };
  } catch (err) {
    return {
      success: false,
      registered,
      message: `${message} Failed to update global host settings: ${errorText(err)}`,
      hostSetting: { updated: false, path: '' },
      restartInstruction: CLAUDE_CODE_RESTART_INSTRUCTION,
    };
  }
}

function cmdClaudeCodeInstall() {
  const result = performClaudeCodeInstall();
  console.log(result.message);
  if (result.hostSetting.updated) {
    console.log(`Updated global host settings at ${result.hostSetting.path}`);
  }
  console.log(result.restartInstruction);
  if (!result.success) {
    process.exit(1);
  }
}

function cmdClaudeCode(args: string[]) {
  const subcommand = args[0];

  switch (subcommand) {
    case 'install':
      return cmdClaudeCodeInstall();
    default:
      console.error(`Unknown claude-code subcommand: ${subcommand}`);
      console.log('Available: install');
      process.exit(1);
  }
}

async function cmdTest() {
  const config = loadConfig();
  const { NtfyTransport } = await import('./ntfy-transport.js');
  const { v4: uuidv4 } = await import('uuid');

  const transport = new NtfyTransport(config);
  const messageId = uuidv4();

  console.log(`Sending test question to topic: ${config.topicId}`);
  console.log(`ntfy URL: ${config.ntfyUrl}`);
  console.log(`Message ID: ${messageId}`);
  console.log('');

  await transport.publish({
    type: 'question',
    messageId,
    timestamp: Date.now(),
    repo: null,
    context: 'This is a test question from the hitl CLI.',
    question: 'Is this test notification working?',
    options: [
      { label: 'Yes, it works!', value: 'yes' },
      { label: 'No, something is wrong', value: 'no' },
    ],
    allowMultiple: false,
    allowOther: true,
    timeout: 60000,
  });

  console.log('✓ Test question published successfully!');
  console.log('Check your HITL client apps — they should show a popup.');
  console.log('');
  console.log('Waiting for response (60s timeout)...');

  try {
    const answer = await transport.waitForAnswer(messageId, AbortSignal.timeout(60000));
    console.log('');
    console.log('✓ Response received!');
    console.log(`  From: ${answer.respondedFrom}`);
    console.log(`  Selected: ${answer.selectedValues.join(', ')}`);
    if (answer.otherText) {
      console.log(`  Additional: ${answer.otherText}`);
    }
  } catch (err) {
    console.log('');
    console.log('⏱ No response received within 60 seconds.');
    console.log('Make sure a HITL client app is running and connected to the same topic.');
  } finally {
    transport.close();
  }
}

// Only run when executed directly (e.g. `node cli.js` / the `hitl` bin), not
// when imported as a module (e.g. from tests) — importing must not have the
// side effect of parsing real process.argv and dispatching a command.
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  main().catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
