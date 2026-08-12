import { structuredPatch, formatPatch } from 'diff';
import type { Hunk, ParsedDiff } from 'diff';
import type { PlanIdentity, RecordedRevision } from './snapshot-store.js';
import { isTracked, readHeadContent } from './git-context.js';

/**
 * The unified diff shipped alongside a plan's current content.
 *
 * Context is effectively infinite, so the "diff" is the whole document with
 * change markers — the reviewer scrolls one continuous plan rather than
 * disconnected hunks, and every line is anchorable.
 *
 * Two cases would otherwise render as an empty document and become
 * unselectable, so both get a synthetic hunk:
 *   - a brand-new plan          → all-added   `@@ -0,0 +1,N @@`
 *   - a byte-identical resubmit → all-context `@@ -1,N +1,N @@`  (B-3)
 *
 * Line endings are preserved verbatim. Normalizing CRLF here would change the
 * line count relative to the snapshot and shift every comment anchor (B-11).
 */

/** Full-document context: large enough that no real plan produces split hunks. */
const FULL_DOCUMENT_CONTEXT = 999_999;

/**
 * How long the diff may run before giving up.
 *
 * `structuredPatch` is synchronous, so its cost is the event loop's cost: the
 * heartbeat cannot fire and every other in-flight request stalls behind it.
 * Measured at 20 s for 10,000 changed lines, extrapolating to roughly 45 s at
 * the 1 MB plan cap — and a normally rewritten plan gets there without anyone
 * trying (H6). Well under the 15 s heartbeat interval, so a bail-out still
 * leaves the call looking alive.
 */
const DIFF_TIMEOUT_MS = 3_000;

/** jsdiff's marker for a final line with no terminating newline. */
const NO_NEWLINE_MARKER = '\\ No newline at end of file';

/**
 * Pick what this revision is diffed against.
 *
 * Revision 1 uses git `HEAD:<relpath>` when the plan is tracked, else nothing
 * (all-added, B-1/B-5). Revision ≥ 2 uses the previous snapshot and ignores git
 * entirely, because plans usually live in gitignored directories where git has
 * no baseline and every revision would otherwise look brand new.
 */
export function resolveBaseline(identity: PlanIdentity, recorded: RecordedRevision): string | null {
  if (recorded.revision >= 2) {
    return recorded.previousContent;
  }
  if (identity.repoRoot && isTracked(identity.repoRoot, identity.resolvedPath)) {
    return readHeadContent(identity.repoRoot, identity.resolvedPath);
  }
  return null;
}

/**
 * Build the unified diff for a plan revision.
 *
 * @param displayPath - Repo-relative path used in the `---`/`+++` headers (F-9)
 * @param content - The revision being reviewed
 * @param baseline - What to diff against, or null for a brand-new plan
 */
export function buildPlanDiff(displayPath: string, content: string, baseline: string | null): string {
  const patch = baseline === null ? null : diffAgainst(displayPath, baseline, content);

  // No baseline, or a comparison that ran out of time: show the whole document
  // as new. The reviewer loses the change markers but keeps every line, which
  // is far better than a call that blocks the process for a minute.
  const resolved: ParsedDiff = patch ?? emptyPatch(displayPath, [allAddedHunk(content)]);

  // Identical revisions produce no hunks at all; substitute the all-context
  // document so an unchanged resubmit stays fully line-selectable (B-3).
  if (resolved.hunks.length === 0) {
    resolved.hunks = [allContextHunk(content)];
  }

  return formatPatch(resolved);
}

/** `structuredPatch` returns undefined when it hits the timeout, despite its types. */
function diffAgainst(displayPath: string, baseline: string, content: string): ParsedDiff | null {
  const patch = structuredPatch(
    `a/${displayPath}`,
    `b/${displayPath}`,
    baseline,
    content,
    undefined,
    undefined,
    // `timeout` is honoured by jsdiff's diff engine (base.js) but missing from
    // @types/diff's PatchOptions, hence the cast.
    { context: FULL_DOCUMENT_CONTEXT, timeout: DIFF_TIMEOUT_MS } as Parameters<
      typeof structuredPatch
    >[6]
  ) as ParsedDiff | undefined;

  if (!patch) {
    console.error(
      `Diff of ${displayPath} exceeded ${DIFF_TIMEOUT_MS}ms; showing the plan without change markers.`
    );
    return null;
  }
  return patch;
}

/** A patch envelope carrying hand-built hunks, named exactly as jsdiff names them. */
function emptyPatch(displayPath: string, hunks: Hunk[]): ParsedDiff {
  return {
    oldFileName: `a/${displayPath}`,
    newFileName: `b/${displayPath}`,
    oldHeader: undefined,
    newHeader: undefined,
    hunks,
  };
}

/** `@@ -0,0 +1,N @@` — every line added. */
function allAddedHunk(content: string): Hunk {
  const { lines, hasTrailingNewline } = splitLinesPreserving(content);
  return {
    // formatPatch applies the unified-diff quirk of printing one less when the
    // side has zero lines, so these starts are the pre-quirk values.
    oldStart: 1,
    oldLines: 0,
    newStart: 1,
    newLines: lines.length,
    lines: prefix(lines, '+', hasTrailingNewline),
  };
}

/** `@@ -1,N +1,N @@` — every line unchanged, but present and therefore selectable. */
function allContextHunk(content: string): Hunk {
  const { lines, hasTrailingNewline } = splitLinesPreserving(content);
  return {
    oldStart: 1,
    oldLines: lines.length,
    newStart: 1,
    newLines: lines.length,
    lines: prefix(lines, ' ', hasTrailingNewline),
  };
}

function prefix(lines: string[], marker: string, hasTrailingNewline: boolean): string[] {
  const out = lines.map((line) => marker + line);
  if (!hasTrailingNewline && out.length > 0) {
    out.push(NO_NEWLINE_MARKER);
  }
  return out;
}

/**
 * Split into lines on LF only, leaving any CR attached to the end of its line.
 *
 * That is what makes a CRLF plan yield the same line count — and therefore the
 * same anchors — as its LF twin, while the bytes travel through untouched.
 */
export function splitLinesPreserving(text: string): { lines: string[]; hasTrailingNewline: boolean } {
  if (text === '') return { lines: [], hasTrailingNewline: true };

  const hasTrailingNewline = text.endsWith('\n');
  const lines = text.split('\n');
  if (hasTrailingNewline) lines.pop();

  return { lines, hasTrailingNewline };
}
