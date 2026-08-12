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
  const patch: ParsedDiff =
    baseline === null
      ? emptyPatch(displayPath, [allAddedHunk(content)])
      : structuredPatch(`a/${displayPath}`, `b/${displayPath}`, baseline, content, undefined, undefined, {
          context: FULL_DOCUMENT_CONTEXT,
        });

  // Identical revisions produce no hunks at all; substitute the all-context
  // document so an unchanged resubmit stays fully line-selectable (B-3).
  if (patch.hunks.length === 0) {
    patch.hunks = [allContextHunk(content)];
  }

  return formatPatch(patch);
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
