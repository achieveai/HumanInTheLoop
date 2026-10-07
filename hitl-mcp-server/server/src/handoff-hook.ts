import { readFileSync } from 'fs';

/**
 * Claude Code Stop hook: make an agent that finished its work hand off to the
 * Inbox (HandOff tool) instead of going quiet and waiting for chat input.
 *
 * The decision is read from the session transcript rather than the hook's
 * `stop_hook_active` flag, because that flag stays set across every handoff
 * cycle in one turn. Anything unexpected allows the stop: the worst case is
 * the behaviour without this hook.
 */

/** Prefix on our block reason, so later runs can find their own blocks. */
export const HOOK_MARKER = '[hitl-handoff]';

export const BLOCK_REASON =
  `${HOOK_MARKER} You finished without handing off. Call the HITL HandOff tool ` +
  'with a short summary and wait for the user\'s next instruction. ' +
  'If HandOff is not available, stop.';

export interface StopHookInput {
  transcript_path?: string;
}

/** One parsed transcript line; only the fields this hook reads. */
export interface TranscriptEntry {
  type?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  entrypoint?: string;
  message?: { content?: unknown };
}

type ContentBlock = {
  type?: string;
  id?: string;
  name?: string;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
  text?: string;
};

export type StopDecision = { block: false; why: string } | { block: true; reason: string; why: string };

function blocks(entry: TranscriptEntry): ContentBlock[] {
  const content = entry.message?.content;
  return Array.isArray(content) ? (content as ContentBlock[]) : [];
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(c => (c as ContentBlock)?.text ?? '').join('');
  return '';
}

/** A prompt that starts a turn: user text that is neither a tool result nor hook feedback. */
function isTurnStart(entry: TranscriptEntry): boolean {
  if (entry.type !== 'user' || entry.isMeta) return false;
  const content = entry.message?.content;
  return typeof content === 'string' || blocks(entry).some(b => b.type === 'text');
}

function isOurBlock(entry: TranscriptEntry): boolean {
  return entry.type === 'user' && entry.isMeta === true &&
    textOf(entry.message?.content).includes(HOOK_MARKER);
}

export function decideStop(entries: TranscriptEntry[], env: NodeJS.ProcessEnv = process.env): StopDecision {
  if (env.HITL_HANDOFF === '0') return { block: false, why: 'disabled by HITL_HANDOFF=0' };

  const main = entries.filter(e => !e.isSidechain);
  const entrypoint = [...main].reverse().find(e => e.entrypoint)?.entrypoint ?? env.CLAUDE_CODE_ENTRYPOINT ?? '';
  // -p and Agent SDK runs have nobody watching an Inbox for them.
  if (entrypoint.startsWith('sdk')) return { block: false, why: `non-interactive entrypoint ${entrypoint}` };

  let start = main.length;
  while (start > 0 && !isTurnStart(main[start - 1])) start--;
  const turn = main.slice(start);

  const handOffIds = new Set<string>();
  let usedTools = false;
  let lastBlock = -1;
  let lastHandOff = -1;
  let lastHandOffResult: ContentBlock | undefined;

  turn.forEach((entry, index) => {
    if (isOurBlock(entry)) lastBlock = index;
    for (const block of blocks(entry)) {
      if (entry.type === 'assistant' && block.type === 'tool_use') {
        usedTools = true;
        if (block.name?.endsWith('__HandOff') && block.id) handOffIds.add(block.id);
      }
      if (block.type === 'tool_result' && block.tool_use_id && handOffIds.has(block.tool_use_id)) {
        lastHandOff = index;
        lastHandOffResult = block;
      }
    }
  });

  if (!usedTools) return { block: false, why: 'no tools used this turn' };

  if (lastHandOffResult && lastHandOff > lastBlock) {
    if (lastHandOffResult.is_error) return { block: false, why: 'HandOff failed' };
    let action: unknown;
    try {
      action = JSON.parse(textOf(lastHandOffResult.content)).action;
    } catch {
      return { block: false, why: 'HandOff result unreadable' };
    }
    if (action === 'end') return { block: false, why: 'user chose End' };
    return { block: true, reason: BLOCK_REASON, why: 'new work since the last HandOff' };
  }

  // The agent ignored our last block: allow the stop rather than loop.
  if (lastBlock >= 0) return { block: false, why: 'agent ignored the previous block' };

  return { block: true, reason: BLOCK_REASON, why: 'finished without HandOff' };
}

function readTranscript(path: string): TranscriptEntry[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(line => line.trim() !== '')
    .flatMap(line => {
      try {
        return [JSON.parse(line) as TranscriptEntry];
      } catch {
        return [];
      }
    });
}

/** Turn the hook's stdin JSON into its stdout. Empty output means "allow the stop". */
export function runStopHook(stdin: string, env: NodeJS.ProcessEnv = process.env): string {
  try {
    const input = JSON.parse(stdin) as StopHookInput;
    if (!input.transcript_path) return '';
    const decision = decideStop(readTranscript(input.transcript_path), env);
    return decision.block ? JSON.stringify({ decision: 'block', reason: decision.reason }) : '';
  } catch {
    return '';
  }
}
