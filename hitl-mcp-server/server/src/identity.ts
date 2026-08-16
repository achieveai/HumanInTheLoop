import { detectRepoContext, isLinkedWorktree } from './git-context.js';
import type { SenderIdentity } from './types.js';

/** Resolves a human-readable session name, or null when none is available. */
export type SessionNameResolver = () => string | null;

/**
 * No documented Claude Code env var exposes a human-readable session name
 * today — only a UUID. This seam lets a real resolver replace this default
 * without touching call sites.
 */
export const defaultSessionNameResolver: SessionNameResolver = () => null;

/** Last two `/`-joined path segments of `cwd`, tolerating either path separator. Never absolute (F-9). */
function lastTwoSegments(cwd: string): string {
  const segments = cwd.split(/[\\/]/).filter(Boolean);
  return segments.slice(-2).join('/');
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
  if (sessionName !== null) return { label: sessionName, source: 'session' };

  if (isLinkedWorktree(cwd)) {
    const branch = detectRepoContext(cwd)?.branch;
    if (branch) return { label: `${deviceName} - ${branch}`, source: 'worktree' };
    // isLinkedWorktree true but no branch (race/edge case) — fall through rather
    // than emit a malformed label.
  }

  return { label: `${deviceName} ${lastTwoSegments(cwd)}`, source: 'path' };
}
