import { execFile } from 'child_process';
import { promisify } from 'util';
import { claimNew, pollAgentMessages, streamAgentMessages } from './agent-messages.js';
import { sessionTag } from './identity.js';
import type { AgentMessage, HitlConfig } from './types.js';

/**
 * Claude Code channel push for the human's Inbox messages.
 *
 * Claude Code only registers a channel when started with `--channels` or
 * `--dangerously-load-development-channels` naming this server, and only in an
 * interactive terminal; the desktop app and IDE extensions run it in SDK mode,
 * where a push is silently dropped. It never says which applies, so the server
 * reads its `claude` ancestor's command line. Only then does it claim messages;
 * otherwise the hooks deliver them. `HITL_CHANNEL=1|0` overrides the check.
 */

const CHANNEL_FLAGS = ['--channels', '--dangerously-load-development-channels'];

/** True when this command line opts a HITL server into channels (`server:<name>` or `plugin:<name>@…`, name containing "hitl"). */
export function namesHitlChannel(commandLine: string): boolean {
  const words = commandLine.split(/\s+/).map(w => w.replace(/^["']|["']$/g, ''));
  let inFlag = false;
  for (const word of words) {
    if (CHANNEL_FLAGS.includes(word)) { inFlag = true; continue; }
    const [flagName, inline] = word.split('=', 2);
    if (inline !== undefined && CHANNEL_FLAGS.includes(flagName)) {
      if (/^(server|plugin):[^\s]*hitl/i.test(inline)) return true;
      continue;
    }
    if (word.startsWith('-')) { inFlag = false; continue; }
    if (inFlag && /^(server|plugin):[^\s]*hitl/i.test(word)) return true;
  }
  return false;
}

interface ProcessRow { pid: number; ppid: number; commandLine: string }

const run = promisify(execFile);

/** Every process with its parent and command line. Empty when the platform will not say. */
async function processTable(): Promise<ProcessRow[]> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress'],
        { maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 15_000 });
      const rows = JSON.parse(stdout) as { ProcessId: number; ParentProcessId: number; CommandLine: string | null }[];
      return rows.map(r => ({ pid: r.ProcessId, ppid: r.ParentProcessId, commandLine: r.CommandLine ?? '' }));
    }
    const { stdout } = await run('ps', ['-A', '-o', 'pid=,ppid=,args='], { maxBuffer: 64 * 1024 * 1024, timeout: 15_000 });
    return stdout.split('\n').flatMap(line => {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), commandLine: m[3] }] : [];
    });
  } catch {
    return [];
  }
}

/** The command lines of this process's ancestors, nearest first. */
export function ancestorCommandLines(rows: ProcessRow[], startPid: number, depth = 6): string[] {
  const byPid = new Map(rows.map(r => [r.pid, r]));
  const lines: string[] = [];
  let pid = startPid;
  for (let i = 0; i < depth; i++) {
    const row = byPid.get(pid);
    if (!row || row.ppid === pid) break;
    const parent = byPid.get(row.ppid);
    if (!parent) break;
    lines.push(parent.commandLine);
    pid = parent.pid;
  }
  return lines;
}

/** Whether Claude Code started this server as a channel. */
export async function detectChannelMode(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (env.HITL_CHANNEL === '1') return true;
  if (env.HITL_CHANNEL === '0') return false;
  if (!env.CLAUDE_CODE_SESSION_ID) return false;
  return ancestorCommandLines(await processTable(), process.pid).some(namesHitlChannel);
}

/** Sends one channel event. Matches `Server.notification`. */
export type Push = (notification: { method: string; params: Record<string, unknown> }) => Promise<void>;

/** The channel event for one message. Meta keys must be identifiers or Claude Code drops them. */
export function channelEvent(msg: AgentMessage) {
  return {
    method: 'notifications/claude/channel',
    params: { content: msg.text, meta: { message_id: msg.messageId, from: msg.from || 'Inbox' } },
  };
}

/**
 * Push this session's messages as they arrive, until `signal` aborts.
 * Messages already waiting are pushed first.
 */
export async function runChannel(config: HitlConfig, rawSessionId: string, push: Push, signal: AbortSignal): Promise<void> {
  const tag = sessionTag(rawSessionId);
  const send = async (messages: AgentMessage[]) => {
    for (const msg of claimNew(tag, messages)) await push(channelEvent(msg)).catch(err =>
      console.error(`hitl: channel push failed for ${msg.messageId}: ${(err as Error).message}`));
  };
  let since = Math.floor(Date.now() / 1000);
  try {
    await send(await pollAgentMessages(config, tag));
  } catch (err) {
    console.error(`hitl: could not check for messages: ${(err as Error).message}`);
  }
  while (!signal.aborted) {
    try {
      await streamAgentMessages(config, tag, since, msg => void send([msg]), signal);
    } catch (err) {
      console.error(`hitl: message stream dropped: ${(err as Error).message}`);
    }
    if (signal.aborted) return;
    since = Math.floor(Date.now() / 1000) - 60;
    await new Promise(resolve => setTimeout(resolve, 5_000));
  }
}
