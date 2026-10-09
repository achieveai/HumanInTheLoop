import { diffArrays } from 'diff';

/** One side's change to the base: replace base lines [start, end) with `lines`. */
interface Hunk {
  start: number;
  end: number;
  lines: string[];
}

/** Split keeping each line's own ending, so a merge never rewrites CRLF vs LF. */
export function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function hunks(base: string[], side: string[]): Hunk[] {
  const out: Hunk[] = [];
  let at = 0;
  let open: Hunk | null = null;
  for (const part of diffArrays(base, side)) {
    const count = part.value.length;
    if (!part.added && !part.removed) {
      if (open) out.push(open);
      open = null;
      at += count;
      continue;
    }
    open ??= { start: at, end: at, lines: [] };
    if (part.removed) {
      open.end += count;
      at += count;
    } else {
      open.lines.push(...part.value);
    }
  }
  if (open) out.push(open);
  return out;
}

/** Base lines [start, end) with every hunk inside that range applied. */
function render(base: string[], start: number, end: number, side: Hunk[]): string[] {
  const out: string[] = [];
  let at = start;
  for (const h of side) {
    out.push(...base.slice(at, h.start), ...h.lines);
    at = h.end;
  }
  out.push(...base.slice(at, end));
  return out;
}

/** A line worth de-duplicating: real content, not a blank line or a `---` rule. */
const isContent = (line: string) => line.trim().length > 3 && line.trim() !== '---';

/**
 * Both runs, `first` then `second`, dropping content lines `second` repeats
 * from `first` (two sides adding the same index line keep it once).
 */
function joinBoth(first: string[], second: string[]): string[] {
  if (first.length === 0) return second;
  const last = first[first.length - 1];
  const head = last.endsWith('\n') ? first : [...first.slice(0, -1), `${last}\n`];
  const seen = new Set(first.filter(isContent).map(line => line.trimEnd()));
  return [...head, ...second.filter(line => !(isContent(line) && seen.has(line.trimEnd())))];
}

/** A memory file's `---` frontmatter block and the body after it. */
export function splitFrontmatter(text: string): { front: string; body: string } {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(text);
  return match ? { front: match[0], body: text.slice(match[0].length) } : { front: '', body: text };
}

/**
 * {@link merge3} for a memory file. The frontmatter is one record (name,
 * description, type), so when both sides changed it the later side's block wins
 * whole; repeating `description:` twice would leave invalid YAML. The body,
 * where the fact lives, keeps both.
 */
export function mergeMemoryFile(base: string, first: string, second: string): MergeResult {
  const [b, f, s] = [base, first, second].map(splitFrontmatter);
  if (!f.front && !s.front) return merge3(base, first, second);
  const front = merge3(b.front, f.front, s.front);
  const body = merge3(b.body, f.body, s.body);
  return {
    text: (front.clashed ? s.front : front.text) + body.text,
    clashed: front.clashed || body.clashed,
  };
}

export interface MergeResult {
  text: string;
  /** True when both sides changed the same lines and both were kept. */
  clashed: boolean;
}

/**
 * Three-way merge where nothing is lost: changes from either side that do not
 * overlap are both applied, and where both sides changed the same lines (or
 * inserted at the same point) both versions are kept, `first`'s then
 * `second`'s, without repeating lines `first` already has.
 *
 * Pure and deterministic. Every machine that merges the same inputs gets the
 * same bytes, which is what lets replicas converge with no arbiter.
 */
export function merge3(base: string, first: string, second: string): MergeResult {
  if (first === second) return { text: first, clashed: false };
  if (base === first) return { text: second, clashed: false };
  if (base === second) return { text: first, clashed: false };

  const b = splitLines(base);
  const isInsert = (h: Hunk) => h.start === h.end;
  // One sweep over both sides' hunks in base order; at the same start a pure
  // insertion goes first, so it lands before the other side's edit there.
  const all = [
    ...hunks(b, splitLines(first)).map(h => ({ ...h, side: 0 })),
    ...hunks(b, splitLines(second)).map(h => ({ ...h, side: 1 })),
  ].sort((x, y) => x.start - y.start || Number(!isInsert(x)) - Number(!isInsert(y)) || x.side - y.side);

  const out: string[] = [];
  let clashed = false;
  let at = 0;
  for (let k = 0; k < all.length;) {
    const region = [all[k++]];
    let start = region[0].start;
    let end = region[0].end;
    // A hunk joins the region when it overlaps it, or when both are insertions at one point.
    while (k < all.length && (all[k].start < end || (start === end && isInsert(all[k]) && all[k].start === start))) {
      end = Math.max(end, all[k].end);
      region.push(all[k++]);
    }
    out.push(...b.slice(at, start));
    const left = region.filter(h => h.side === 0);
    const right = region.filter(h => h.side === 1);
    const leftLines = render(b, start, end, left);
    const rightLines = render(b, start, end, right);
    if (right.length === 0) out.push(...leftLines);
    else if (left.length === 0) out.push(...rightLines);
    else if (leftLines.join('') === rightLines.join('')) out.push(...leftLines);
    else {
      clashed = true;
      out.push(...joinBoth(leftLines, rightLines));
    }
    at = end;
  }
  out.push(...b.slice(at));
  return { text: out.join(''), clashed };
}
