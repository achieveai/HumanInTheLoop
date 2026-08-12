import type { InlineComment, PlanVerdict, PlanReviewResponseBody } from './types.js';

/**
 * Pure shaping and validation of a plan-review response.
 *
 * Kept out of mcp-server.ts so it can be tested without booting an MCP server,
 * and because the rules here are the authoritative ones — the review window
 * mirrors them for fast feedback, but the server decides.
 */

/** Every verdict the wire may legitimately carry. */
export const VALID_VERDICTS: readonly PlanVerdict[] = [
  'approved',
  'changes_requested',
  'rejected',
  'skipped',
  'cancelled',
];

/** Verdicts that say "change something" and therefore must say what (A-5). */
const VERDICTS_REQUIRING_FEEDBACK: readonly PlanVerdict[] = ['changes_requested', 'rejected'];

/** Raised when a response cannot be accepted as submitted. */
export class ReviewResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewResponseError';
  }
}

/** What ReviewPlan returns to the agent. */
export interface ReviewPlanResult {
  success: true;
  timestamp: number;
  respondedFrom: string;
  verdict: PlanVerdict;
  overallFeedback: string;
  inlineComments: InlineComment[];
  revision: number;
  isNewPlan: boolean;
  /** 'sha256:<hex>' of the content the human actually reviewed (A-8). */
  snapshotHash: string;
}

/** Coerce an unknown verdict string, defaulting to the least destructive reading. */
export function parseVerdict(raw: unknown): PlanVerdict {
  return VALID_VERDICTS.includes(raw as PlanVerdict) ? (raw as PlanVerdict) : 'skipped';
}

/**
 * Trim, drop empties, and sort inline comments into a canonical order.
 *
 * The comparator is total — it falls through to the comment text — so the same
 * set of comments serializes byte-identically no matter which order the human
 * clicked them in (A-4). A merely stable sort would not achieve that: two
 * comments on one anchor would keep their insertion order.
 */
export function normalizeInlineComments(raw: unknown, defaultPath: string): InlineComment[] {
  if (!Array.isArray(raw)) return [];

  const cleaned: InlineComment[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const c = entry as Partial<InlineComment>;

    const comment = typeof c.comment === 'string' ? c.comment.trim() : '';
    if (comment === '') continue; // An empty comment anchors nothing.

    const startLine = toLineNumber(c.startLine, 1);
    const endLine = Math.max(startLine, toLineNumber(c.endLine, startLine));

    cleaned.push({
      path: typeof c.path === 'string' && c.path !== '' ? c.path : defaultPath,
      startLine,
      endLine,
      side: c.side === 'old' ? 'old' : 'new',
      comment,
    });
  }

  return cleaned.sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.startLine - b.startLine ||
      a.endLine - b.endLine ||
      a.side.localeCompare(b.side) ||
      a.comment.localeCompare(b.comment)
  );
}

/**
 * Normalize a decoded response body and enforce the server-side rules.
 *
 * `changes_requested` and `rejected` need either overall feedback or at least
 * one surviving inline comment; anything else leaves the agent told to change
 * something with no indication of what (A-5).
 */
export function normalizeResponseBody(
  verdict: PlanVerdict,
  raw: unknown,
  defaultPath: string
): PlanReviewResponseBody {
  const body = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<PlanReviewResponseBody>;

  const overallFeedback = typeof body.overallFeedback === 'string' ? body.overallFeedback.trim() : '';
  const inlineComments = normalizeInlineComments(body.inlineComments, defaultPath);

  if (
    VERDICTS_REQUIRING_FEEDBACK.includes(verdict) &&
    overallFeedback === '' &&
    inlineComments.length === 0
  ) {
    throw new ReviewResponseError(
      `Verdict '${verdict}' requires either overall feedback or at least one inline comment, ` +
        `but the response carried neither.`
    );
  }

  return { overallFeedback, inlineComments };
}

function toLineNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : fallback;
}
