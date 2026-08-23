import { randomUUID } from 'crypto';
import { detectRepoContext, isLinkedWorktree } from './git-context.js';
import type { RepoContext, SenderIdentity } from './types.js';

/** Resolves a human-readable session name, or null when none is available. */
export type SessionNameResolver = () => string | null;

/** One MCP server process is exactly one Claude Code session. */
const PROCESS_SESSION_UUID = randomUUID();

/**
 * Builds a `SessionNameResolver` that prefers the Claude Code Remote Control
 * bridge session id (`CLAUDE_CODE_BRIDGE_SESSION_ID`, set only while Remote
 * Control is active, v2.1.199+) and falls back to a minted id otherwise
 * (spec §5.2, §5.3).
 *
 * The bridge id can appear or disappear mid-process, so the result is
 * resolved once, at first call, and cached — a label that changes mid-session
 * would be worse than one that is merely opportunistic.
 */
export function makeSessionNameResolver(opts: {
  env: NodeJS.ProcessEnv;
  mintedUuid: string;
}): SessionNameResolver {
  let resolved: string | null = null;
  return () => {
    if (resolved === null) {
      resolved = opts.env.CLAUDE_CODE_BRIDGE_SESSION_ID ?? opts.mintedUuid;
    }
    return resolved;
  };
}

export const defaultSessionNameResolver: SessionNameResolver = makeSessionNameResolver({
  env: process.env,
  mintedUuid: PROCESS_SESSION_UUID,
});

/**
 * Stable key for "which project" a session belongs to (spec §5.4).
 * `CLAUDE_PROJECT_DIR` is documented and survives `--resume`/context
 * compaction, unlike `process.cwd()`; `repo.remoteUrl` survives the repo
 * being moved or re-cloned to a different path; `cwd` is the last resort.
 */
export function resolveProjectKey(cwd: string, repo: RepoContext | null): string {
  return process.env.CLAUDE_PROJECT_DIR ?? repo?.remoteUrl ?? cwd;
}

/** Last two `/`-joined path segments of `cwd`, tolerating either path separator. Never absolute (F-9). */
function lastTwoSegments(cwd: string): string {
  const segments = cwd.split(/[\\/]/).filter(Boolean);
  return segments.slice(-2).join('/');
}

/**
 * Compose the session-tier display label per spec §5.4:
 * `<repoName> · <branch> · <first-4-of-id>`. A raw session id/UUID on its own
 * is meaningless in a message list, so this always folds in repo context
 * when one is available — preferring `CLAUDE_PROJECT_DIR` as the directory to
 * inspect since it is stable across `--resume`/compaction, unlike `cwd` —
 * and falls back to the path tier's own last-two-segments heuristic when
 * that directory isn't a git repo at all.
 */
/**
 * The discriminating part of a session id.
 *
 * Claude Code's bridge ids are all shaped `session_<opaque>`, so taking the
 * first four characters of one yields the literal `sess` for every session on
 * every machine — a disambiguator that disambiguates nothing, which is the
 * whole job this suffix exists to do. Minted UUIDs have no such prefix and are
 * unaffected.
 *
 * Stripping a known prefix rather than, say, slicing from the end keeps the
 * suffix recognisable as the head of an id a user can match against a real
 * session, and leaves the UUID case byte-for-byte as it was.
 */
function shortSessionId(sessionId: string): string {
  return sessionId.replace(/^session_/, '').slice(0, 4);
}

function composeSessionLabel(cwd: string, sessionId: string): string {
  const shortId = shortSessionId(sessionId);
  const repo = detectRepoContext(process.env.CLAUDE_PROJECT_DIR ?? cwd);
  if (repo) return `${repo.name} · ${repo.branch} · ${shortId}`;
  return `${lastTwoSegments(cwd)} · ${shortId}`;
}

/**
 * Resolve a display-ready sender identity for an outgoing message, in
 * precedence order: session name override > linked-worktree branch > path
 * fallback.
 *
 * Purely a function of its arguments — never reads `process.cwd()` or
 * `os.hostname()` itself, so callers control (and tests can mock) both `cwd`
 * and `deviceName`; per-tool cwd rules live at each call site.
 */
export function resolveSenderIdentity(
  cwd: string,
  deviceName: string,
  sessionResolver: SessionNameResolver = defaultSessionNameResolver
): SenderIdentity {
  const sessionName = sessionResolver();
  if (sessionName !== null) return { label: composeSessionLabel(cwd, sessionName), source: 'session' };

  if (isLinkedWorktree(cwd)) {
    const branch = detectRepoContext(cwd)?.branch;
    if (branch) return { label: `${deviceName} - ${branch}`, source: 'worktree' };
    // isLinkedWorktree true but no branch (race/edge case) — fall through rather
    // than emit a malformed label.
  }

  return { label: `${deviceName} ${lastTwoSegments(cwd)}`, source: 'path' };
}
