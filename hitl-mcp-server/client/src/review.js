// Plan-review rendering and interaction logic for the HITL Tauri client.
//
// This module is deliberately free of Tauri access: `renderPlanReview` is a pure
// function over (container, planMessage, callbacks), mirroring `renderDialog` in
// dialog.js. review.html injects Tauri-backed callbacks; review-harness.html
// injects fixture-backed ones. That is what makes the lane testable without a
// running Rust client.

/**
 * Escape HTML to prevent XSS in untrusted plan content.
 *
 * A plan is untrusted input — prompt injection via a README, a fetched page or
 * dependency docs is mainstream, and ReviewPlan is precisely the gate meant to
 * catch a misbehaving agent, so it must be robust against what it gates.
 */
function escapeHtml(text) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return String(text ?? '').replace(/[&<>"']/g, m => map[m]);
}

/**
 * Split text into lines for line-number purposes.
 *
 * Deliberately NOT `normalizeNewlines()` (dialog.js:17). That helper rewrites
 * literal backslash-n two-character sequences into real newlines; applied to a
 * plan body it would shift every subsequent line number and silently point
 * every anchor at the wrong line, with no error (G-1).
 *
 * Handles CRLF, LF and lone CR. Callers index the result from 1.
 */
export function splitLines(text) {
    if (text === null || text === undefined || text === '') return [];
    return String(text).split(/\r\n|\n|\r/);
}

/**
 * Parse a unified diff into rows carrying source-line coordinates.
 *
 * Anchors live in source-line space — the old/new file line numbers taken from
 * the `@@` hunk headers — never in DOM-node space. That is what lets
 * rendered-pane commenting be added later with no data-model change.
 *
 * Rows are `{kind, text, side, line, oldLine, newLine}`. `side`/`line` are the
 * anchor coordinates and are absent on non-selectable rows (`meta`, `hunk`).
 * Added and context lines anchor to the new side; removed lines to the old.
 */
export function parseDiff(diffText) {
    const rows = [];
    let oldLine = 0;
    let newLine = 0;
    let inHunk = false;

    for (const raw of splitLines(diffText)) {
        const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
        if (hunk) {
            oldLine = parseInt(hunk[1], 10);
            newLine = parseInt(hunk[2], 10);
            inHunk = true;
            rows.push({ kind: 'hunk', text: raw });
            continue;
        }
        if (!inHunk) {
            rows.push({ kind: 'meta', text: raw });
            continue;
        }
        const marker = raw.charAt(0);
        if (marker === '+') {
            rows.push({ kind: 'add', text: raw.slice(1), side: 'new', line: newLine, newLine });
            newLine++;
        } else if (marker === '-') {
            rows.push({ kind: 'del', text: raw.slice(1), side: 'old', line: oldLine, oldLine });
            oldLine++;
        } else if (marker === '\\') {
            // "\ No newline at end of file" — carries no source line of its own.
            rows.push({ kind: 'meta', text: raw });
        } else {
            // A leading space, or an empty string from a generator that trims it.
            rows.push({ kind: 'context', text: raw.slice(1), side: 'new', line: newLine, oldLine, newLine });
            oldLine++;
            newLine++;
        }
    }
    return rows;
}

/**
 * Rows for a plan with no diff — every line is plain new-side content.
 * Defensive: the server always sends a diff, including an all-context synthetic
 * hunk for a byte-identical resubmit, so this is a fallback rather than a path.
 */
function rowsFromContent(content) {
    return splitLines(content).map((text, i) => ({
        kind: 'context', text, side: 'new', line: i + 1, oldLine: i + 1, newLine: i + 1,
    }));
}

/**
 * Build a markdown-it instance for the read-only rendered pane.
 *
 * `html: false` is markdown-it's default and is load-bearing: it drops raw HTML
 * entirely, which kills both the zero-JS UI-spoof (a plan containing
 * `<div style="position:fixed;inset:0;z-index:9999">`) and the injected-script
 * forged-verdict rung for free (F-5, F-6). Never enable it.
 */
function createMarkdownRenderer() {
    if (typeof window.markdownit !== 'function') return null;
    const md = window.markdownit({ html: false, linkify: true, typographer: false });

    // F-7: nothing fetches on render. A remote `![](https://attacker/?d=…)` is a
    // no-JS exfil channel that survives sanitisation — it is a legitimate image.
    // Remote images become click-to-load placeholders showing their URL.
    const renderToken = (tokens, idx, options, env, self) => self.renderToken(tokens, idx, options);
    const defaultImage = md.renderer.rules.image || renderToken;
    md.renderer.rules.image = (tokens, idx, options, env, self) => {
        const src = tokens[idx].attrGet('src') || '';
        if (/^data:/i.test(src)) return defaultImage(tokens, idx, options, env, self);
        const alt = tokens[idx].content || 'image';
        return `<span class="md-image-placeholder" role="button" tabindex="0" data-src="${escapeHtml(src)}"
            aria-label="Load remote image ${escapeHtml(src)}"><span class="md-image-icon">🖼</span><span
            class="md-image-alt">${escapeHtml(alt)}</span><span class="md-image-url">${escapeHtml(src)}</span><span
            class="md-image-hint">click to load</span></span>`;
    };
    return md;
}

function logicalSourceLines(text) {
    if (text === null || text === undefined || text === '') return [];
    const source = String(text);
    const lines = splitLines(source);
    if (/(?:\r\n|\n|\r)$/.test(source) && lines.at(-1) === '') lines.pop();
    return lines;
}

/**
 * Rebuild the previous Markdown document from the full-document unified diff.
 *
 * The current document always comes from the hash-checked body, never from the
 * patch. A malformed, partial, or mismatched patch therefore degrades to a
 * truthful current document plus an unavailable previous document rather than
 * presenting invented prose as something the agent removed.
 */
export function reconstructReviewDocuments(content, diffText) {
    const newSource = typeof content === 'string' ? content : '';
    const authoritativeNewLines = logicalSourceLines(newSource);
    const failed = reason => ({
        ok: false,
        reason,
        oldSource: '',
        newSource,
        oldLines: [],
        newLines: authoritativeNewLines,
    });
    if (typeof diffText !== 'string' || diffText === '') {
        return { ok: true, oldSource: '', newSource, oldLines: [], newLines: authoritativeNewLines };
    }

    const rawLines = splitLines(diffText);
    if (/(?:\r\n|\n|\r)$/.test(diffText) && rawLines.at(-1) === '') rawLines.pop();
    const hunks = rawLines
        .map((line, index) => ({ line, index, match: /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line) }))
        .filter(entry => entry.match);
    if (hunks.length !== 1) return failed('The review patch is not one complete document hunk.');

    const [{ index: hunkIndex, match }] = hunks;
    const oldStart = Number(match[1]);
    const oldCount = match[2] === undefined ? 1 : Number(match[2]);
    const newStart = Number(match[3]);
    const newCount = match[4] === undefined ? 1 : Number(match[4]);
    if ((oldCount === 0 ? oldStart !== 0 : oldStart !== 1)
        || (newCount === 0 ? newStart !== 0 : newStart !== 1)) {
        return failed('The review patch omits document context.');
    }

    const oldLines = [];
    const newLines = [];
    let oldHasFinalNewline = true;
    let newHasFinalNewline = true;
    let sawNoFinalNewlineMarker = false;
    let previousMarker = null;
    for (const raw of rawLines.slice(hunkIndex + 1)) {
        const marker = raw.charAt(0);
        if (marker === '\\') {
            if (raw !== '\\ No newline at end of file' || previousMarker === null) {
                return failed('The review patch has an invalid newline marker.');
            }
            sawNoFinalNewlineMarker = true;
            if (previousMarker === '-' || previousMarker === ' ') oldHasFinalNewline = false;
            if (previousMarker === '+' || previousMarker === ' ') newHasFinalNewline = false;
            continue;
        }
        const text = raw.slice(1);
        if (marker === ' ') {
            oldLines.push(text);
            newLines.push(text);
        } else if (marker === '-') {
            oldLines.push(text);
        } else if (marker === '+') {
            newLines.push(text);
        } else {
            return failed('The review patch contains a row without a unified-diff marker.');
        }
        previousMarker = marker;
    }

    if (oldLines.length !== oldCount || newLines.length !== newCount) {
        return failed('The review patch line counts do not match its hunk header.');
    }
    const authoritativeHasFinalNewline = newSource.length > 0 && /(?:\r\n|\n|\r)$/.test(newSource);
    // Some producers omit the marker when both documents share the same EOF
    // state. In that case the hash-checked current body is authoritative for
    // both sides; otherwise reconstruction invents a false remove/add pair.
    if (!sawNoFinalNewlineMarker) {
        oldHasFinalNewline = authoritativeHasFinalNewline;
        newHasFinalNewline = authoritativeHasFinalNewline;
    }
    if (newHasFinalNewline !== authoritativeHasFinalNewline) {
        return failed('The review patch final-newline state disagrees with the current plan body.');
    }
    if (newLines.length !== authoritativeNewLines.length
        || newLines.some((line, index) => line !== authoritativeNewLines[index])) {
        return failed('The review patch does not describe the current plan body.');
    }

    const oldSource = oldLines.join('\n')
        + (oldHasFinalNewline && oldLines.length > 0 ? '\n' : '');
    return { ok: true, oldSource, newSource, oldLines, newLines: authoritativeNewLines };
}

const MAPPED_BLOCK_SELECTOR = '[data-source-start][data-source-end][data-source-side]';
const mappedControllerCleanup = new WeakMap();

function clearMappedController(container) {
    mappedControllerCleanup.get(container)?.();
    mappedControllerCleanup.delete(container);
}

/** Release document-level review listeners before a host is removed externally. */
export function disposeReview(container) {
    if (container) clearMappedController(container);
}

/**
 * Render a complete Markdown document while retaining markdown-it's block maps.
 * Token maps are zero-based and half-open; review anchors are 1-based and
 * inclusive. Only source-backed opening/standalone block tokens can emit an
 * element, so inline containers and closing tokens deliberately carry no DOM
 * metadata.
 */
export function renderMappedMarkdown(md, text, side = 'new') {
    if (!md) return null;
    const fixedSide = side === 'old' ? 'old' : 'new';
    const env = {};
    const tokens = md.parse(text || '', env);
    for (const token of tokens) {
        const start = token.map?.[0];
        const end = token.map?.[1];
        if (!token.block || token.type === 'inline' || (token.nesting !== 1 && token.nesting !== 0)) continue;
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) continue;
        token.attrSet('data-source-start', String(start + 1));
        token.attrSet('data-source-end', String(end));
        token.attrSet('data-source-side', fixedSide);
    }
    return md.renderer.render(tokens, md.options, env);
}

const FORMATTED_DIFF_TIMEOUT_MS = 50;
const FORMATTED_DIFF_MAX_EDIT_LENGTH = 2000;

function normalizeVisibleText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
}

function sourceSlice(lines, startLine, endLine) {
    return lines.slice(startLine - 1, endLine).join('\n');
}

/** Parse once, retaining complete top-level blocks for alignment and inner maps for selection. */
function createMappedDocument(md, source, side) {
    const html = renderMappedMarkdown(md, source, side) || '';
    const template = document.createElement('template');
    template.innerHTML = html;
    const lines = logicalSourceLines(source);
    const renderedBlocks = Array.from(template.content.children)
        .map(element => {
            let mapped = mappedElementData(element);
            if (!mapped) {
                // markdown-it's fence renderer places token attributes on the
                // inner <code>. Alignment must still operate on the complete
                // top-level <pre>, never on a fragment of a rendered block.
                const descendants = Array.from(element.querySelectorAll(MAPPED_BLOCK_SELECTOR))
                    .map(node => ({ node, mapped: mappedElementData(node) }))
                    .filter(item => item.mapped);
                const sides = new Set(descendants.map(item => item.mapped.side));
                if (descendants.length && sides.size === 1) {
                    mapped = {
                        startLine: Math.min(...descendants.map(item => item.mapped.startLine)),
                        endLine: Math.max(...descendants.map(item => item.mapped.endLine)),
                        side: descendants[0].mapped.side,
                    };
                    element.setAttribute('data-source-start', String(mapped.startLine));
                    element.setAttribute('data-source-end', String(mapped.endLine));
                    element.setAttribute('data-source-side', mapped.side);
                    // A descendant with exactly the promoted range is not a
                    // separate source block; leaving both would make the same
                    // fence appear twice to selection and accessibility APIs.
                    descendants.filter(item => item.mapped.startLine === mapped.startLine
                        && item.mapped.endLine === mapped.endLine)
                        .forEach(item => {
                            item.node.removeAttribute('data-source-start');
                            item.node.removeAttribute('data-source-end');
                            item.node.removeAttribute('data-source-side');
                        });
                }
            }
            if (!mapped) return null;
            return {
                ...mapped,
                source: sourceSlice(lines, mapped.startLine, mapped.endLine),
                visibleText: normalizeVisibleText(element.textContent),
                html: element.outerHTML,
                sourceOnly: false,
                rejectedHtml: /<\/?[A-Za-z][^>]*>/.test(sourceSlice(lines, mapped.startLine, mapped.endLine)),
            };
        })
        .filter(Boolean)
        .sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);

    // Reference definitions and other parser-consumed source have no DOM node.
    // Keep each contiguous nonblank gap as a block so a destination-only change
    // can never disappear from the formatted comparison.
    const blocks = [];
    let cursor = 1;
    const addGaps = endExclusive => {
        let runStart = null;
        for (let line = cursor; line < endExclusive; line++) {
            if ((lines[line - 1] || '').trim()) {
                if (runStart === null) runStart = line;
            } else if (runStart !== null) {
                const raw = sourceSlice(lines, runStart, line - 1);
                blocks.push({ side, startLine: runStart, endLine: line - 1, source: raw,
                    visibleText: '', html: '', sourceOnly: true, rejectedHtml: /<\/?[A-Za-z][^>]*>/.test(raw) });
                runStart = null;
            }
        }
        if (runStart !== null) {
            const raw = sourceSlice(lines, runStart, endExclusive - 1);
            blocks.push({ side, startLine: runStart, endLine: endExclusive - 1, source: raw,
                visibleText: '', html: '', sourceOnly: true, rejectedHtml: /<\/?[A-Za-z][^>]*>/.test(raw) });
        }
    };
    for (const block of renderedBlocks) {
        if (block.startLine > cursor) addGaps(block.startLine);
        blocks.push(block);
        cursor = Math.max(cursor, block.endLine + 1);
    }
    if (cursor <= lines.length) addGaps(lines.length + 1);
    blocks.sort((a, b) => a.startLine - b.startLine || Number(a.sourceOnly) - Number(b.sourceOnly));
    if (blocks.length === 0 && source.length > 0) {
        blocks.push({ side, startLine: 1, endLine: Math.max(1, lines.length), source,
            comparisonSource: source, visibleText: '', html: '', sourceOnly: true, rejectedHtml: false });
    }
    const hasFinalNewline = /(?:\r\n|\n|\r)$/.test(source);
    blocks.forEach((block, index) => {
        const startLine = index === 0 ? 1 : block.startLine;
        const next = blocks[index + 1];
        const endLine = next ? next.startLine - 1 : lines.length;
        block.comparisonSource = sourceSlice(lines, startLine, Math.max(startLine - 1, endLine));
        if (!next) block.comparisonSource += hasFinalNewline ? '\n<EOF-newline>' : '<EOF-no-newline>';
    });
    return { side, source, html, blocks };
}

function changeHunkIsSourceOnly(removed, added) {
    const oldRaw = removed.map(block => block.comparisonSource ?? block.source).join('\n');
    const newRaw = added.map(block => block.comparisonSource ?? block.source).join('\n');
    const oldVisible = normalizeVisibleText(removed.map(block => block.visibleText).join(' '));
    const newVisible = normalizeVisibleText(added.map(block => block.visibleText).join(' '));
    // A source-only marker is warranted only when the rendered meaning is
    // unchanged. Merely containing an HTML-looking token (for example `<T>`
    // in code) does not make a visible change source-only.
    return oldRaw !== newRaw && oldVisible === newVisible;
}

/** Bounded complete-block alignment. `undefined` is a deliberate safe fallback. */
function createFormattedModel(md, documents, bounds = {}) {
    const parseStarted = performance.now();
    const oldDocument = createMappedDocument(md, documents.oldSource, 'old');
    const newDocument = createMappedDocument(md, documents.newSource, 'new');
    const parseMs = performance.now() - parseStarted;
    if (!documents.ok) return { ok: false, reason: documents.reason, oldDocument, newDocument,
        hunks: [], parseMs, diffMs: 0 };
    const diffApi = window.Diff;
    if (!diffApi || typeof diffApi.diffArrays !== 'function') {
        return { ok: false, reason: 'The local formatted-diff library is unavailable.', oldDocument, newDocument,
            hunks: [], parseMs, diffMs: 0 };
    }
    let runs;
    const diffStarted = performance.now();
    try {
        runs = diffApi.diffArrays(oldDocument.blocks, newDocument.blocks, {
            comparator: (oldBlock, newBlock) => (oldBlock.comparisonSource ?? oldBlock.source)
                === (newBlock.comparisonSource ?? newBlock.source),
            timeout: bounds.timeout ?? FORMATTED_DIFF_TIMEOUT_MS,
            maxEditLength: bounds.maxEditLength ?? FORMATTED_DIFF_MAX_EDIT_LENGTH,
        });
    } catch (error) {
        return { ok: false, reason: error?.message || 'Formatted block alignment failed.', oldDocument, newDocument,
            hunks: [], parseMs, diffMs: performance.now() - diffStarted };
    }
    const diffMs = performance.now() - diffStarted;
    if (!Array.isArray(runs)) {
        return { ok: false, reason: 'Formatted block alignment exceeded its work limit.', oldDocument, newDocument,
            hunks: [], parseMs, diffMs };
    }

    const segments = [];
    const hunks = [];
    let pending = null;
    const flushPending = () => {
        if (!pending) return;
        pending.id = `change-${hunks.length + 1}`;
        pending.sourceOnly = changeHunkIsSourceOnly(pending.removed, pending.added);
        hunks.push(pending);
        segments.push({ kind: 'change', hunk: pending });
        pending = null;
    };
    for (const run of runs) {
        const value = Array.isArray(run.value) ? run.value : [];
        if (run.added || run.removed) {
            pending ||= { removed: [], added: [] };
            pending[run.removed ? 'removed' : 'added'].push(...value);
        } else {
            flushPending();
            segments.push({ kind: 'equal', blocks: value });
        }
    }
    flushPending();
    return { ok: true, oldDocument, newDocument, segments, hunks, parseMs, diffMs };
}

function formattedBlockHtml(block, kind, hunkId) {
    if (block.sourceOnly) return '';
    if (kind === 'equal') return block.html;
    const label = kind === 'removed' ? 'Removed' : 'Added';
    return `<div class="formatted-change formatted-change-${kind}" data-change-hunk="${hunkId}">
        <div class="formatted-change-label">${label}</div>${block.html}</div>`;
}

function renderEqualBlocks(blocks, collapsedRuns) {
    if (blocks.length <= 20 || blocks.some(block => block.sourceOnly)) {
        return blocks.map(block => formattedBlockHtml(block, 'equal', '')).join('');
    }
    const leading = blocks.slice(0, 3);
    const hidden = blocks.slice(3, -3);
    const trailing = blocks.slice(-3);
    const collapsedId = `unchanged-${collapsedRuns.size + 1}`;
    collapsedRuns.set(collapsedId, hidden);
    return `${leading.map(block => formattedBlockHtml(block, 'equal', '')).join('')}
        <div class="formatted-unchanged-collapsed">
            <button type="button" class="formatted-unchanged-reveal" data-collapsed-run="${collapsedId}">Show ${hidden.length} unchanged blocks</button>
        </div>
        ${trailing.map(block => formattedBlockHtml(block, 'equal', '')).join('')}`;
}

function renderChangesHtml(model, collapsedRuns) {
    if (!model.ok) {
        return model.newDocument.blocks.map(block => formattedBlockHtml(block, 'added', 'change-fallback')).join('');
    }
    return model.segments.map(segment => {
        if (segment.kind === 'equal') {
            return renderEqualBlocks(segment.blocks, collapsedRuns);
        }
        const hunk = segment.hunk;
        const indicator = hunk.sourceOnly
            ? `<button type="button" class="source-change-indicator" data-source-hunk="${hunk.id}">Source change; inspect Source</button>`
            : '';
        return `<section class="formatted-hunk" id="${hunk.id}" tabindex="-1" aria-label="Changed section">
            ${hunk.removed.map(block => formattedBlockHtml(block, 'removed', hunk.id)).join('')}
            ${hunk.added.map(block => formattedBlockHtml(block, 'added', hunk.id)).join('')}
            ${indicator}</section>`;
    }).join('');
}

function renderBeforeAfterDocument(documentModel, kind, changedBlocks = new Map()) {
    if (documentModel.blocks.length === 0) {
        return '<p class="formatted-empty">No previous plan.</p>';
    }
    return documentModel.blocks.map(block => {
        if (block.sourceOnly) return '';
        return changedBlocks.has(block) ? formattedBlockHtml(block, kind, changedBlocks.get(block)) : block.html;
    }).join('');
}

function mappedElementData(element) {
    const startLine = Number(element?.getAttribute('data-source-start'));
    const endLine = Number(element?.getAttribute('data-source-end'));
    const side = element?.getAttribute('data-source-side');
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine)
        || startLine < 1 || endLine < startLine || (side !== 'old' && side !== 'new')) return null;
    return { startLine, endLine, side };
}

function nodeInside(root, node) {
    if (!root || !node) return false;
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return element === root || root.contains(element);
}

/**
 * Return mapped leaves from a document-ordered element list in linear work.
 * Each element is pushed and popped once; the nearest mapped parent is enough
 * to mark every non-leaf because that parent was itself marked by its child.
 */
function innermostMappedElements(elements, stats = null) {
    const stack = [];
    const nonLeaves = new Set();
    let containmentChecks = 0;
    for (const element of elements) {
        while (stack.length) {
            containmentChecks++;
            if (stack.at(-1).contains(element)) break;
            stack.pop();
        }
        if (stack.length) nonLeaves.add(stack.at(-1));
        stack.push(element);
    }
    if (stats) stats.containmentChecks = containmentChecks;
    return elements.filter(element => !nonLeaves.has(element));
}

/** Resolve a live DOM selection to the innermost intersecting mapped blocks. */
export function mappedAnchorFromSelection(root, domSelection = window.getSelection(), stats = null) {
    if (!root || !domSelection || domSelection.rangeCount !== 1 || domSelection.isCollapsed
        || !domSelection.toString()) return null;
    const range = domSelection.getRangeAt(0);
    if (range.collapsed || !nodeInside(root, range.startContainer) || !nodeInside(root, range.endContainer)) return null;

    let intersectionTests = 0;
    const intersected = Array.from(root.querySelectorAll(MAPPED_BLOCK_SELECTOR)).filter(element => {
        if (!mappedElementData(element)) return false;
        intersectionTests++;
        try { return range.intersectsNode(element); } catch { return false; }
    });
    if (stats) {
        stats.intersectionTests = intersectionTests;
        stats.intersected = intersected.length;
    }
    const innermost = innermostMappedElements(intersected, stats);
    if (innermost.length === 0) return null;

    const mapped = innermost.map(mappedElementData);
    const sides = new Set(mapped.map(item => item.side));
    if (sides.size !== 1) return null;
    return {
        startLine: Math.min(...mapped.map(item => item.startLine)),
        endLine: Math.max(...mapped.map(item => item.endLine)),
        side: mapped[0].side,
    };
}

function mappedLeafElements(root) {
    const mapped = Array.from(root?.querySelectorAll(MAPPED_BLOCK_SELECTOR) || [])
        .filter(element => mappedElementData(element));
    return innermostMappedElements(mapped);
}

function createMappedDocumentController(root, action, onActivate, onSelectionMeasured = () => {}, onLeafMeasured = () => {}) {
    let candidate = null;
    let readOnly = false;
    let scheduledFrame = null;
    let destroyed = false;
    const listenerAbort = new AbortController();
    const view = root.ownerDocument.defaultView || window;
    const leaves = () => {
        const elements = mappedLeafElements(root);
        onLeafMeasured(elements.length);
        return elements;
    };

    function destroy() {
        if (destroyed) return;
        destroyed = true;
        listenerAbort.abort();
        if (scheduledFrame !== null) view.cancelAnimationFrame(scheduledFrame);
        scheduledFrame = null;
    }

    function paintCandidate() {
        leaves().forEach(element => element.classList.toggle(
            'is-selection-candidate',
            Boolean(candidate && (() => {
                const mapped = mappedElementData(element);
                return mapped.side === candidate.side
                    && mapped.endLine >= candidate.startLine
                    && mapped.startLine <= candidate.endLine;
            })()),
        ));
        action.disabled = readOnly || !candidate;
    }

    function refreshCandidate() {
        const started = performance.now();
        const nextCandidate = readOnly ? null : mappedAnchorFromSelection(root);
        onSelectionMeasured(performance.now() - started);
        if (!nextCandidate && !candidate && !root.querySelector('.is-selection-candidate')) {
            action.disabled = true;
            return;
        }
        candidate = nextCandidate;
        paintCandidate();
    }

    const scheduleCandidateRefresh = () => {
        // Pointer default actions finalize a click-count/drag selection after
        // pointerup dispatch. Read it on the next frame, not one event early.
        if (destroyed || readOnly || !root.isConnected || scheduledFrame !== null) return;
        scheduledFrame = view.requestAnimationFrame(() => {
            scheduledFrame = null;
            refreshCandidate();
        });
    };
    root.addEventListener('pointerup', scheduleCandidateRefresh);
    root.addEventListener('mouseup', scheduleCandidateRefresh);
    root.ownerDocument.addEventListener('selectionchange', scheduleCandidateRefresh, {
        signal: listenerAbort.signal,
    });
    action.addEventListener('pointerdown', (event) => {
        // Preserve touch selection handles until the explicit action commits
        // the cached source range. Keyboard activation has no pointerdown.
        if (candidate) event.preventDefault();
    });
    action.addEventListener('click', () => {
        if (!candidate) return;
        const selected = candidate;
        candidate = null;
        window.getSelection()?.removeAllRanges();
        paintCandidate();
        onActivate(selected);
    });

    return {
        destroy,
        clearCandidate() {
            candidate = null;
            paintCandidate();
        },
        setResolved(resolved) {
            readOnly = resolved;
            if (resolved) candidate = null;
            paintCandidate();
        },
        paintSelection(anchor) {
            leaves().forEach(element => {
                const mapped = mappedElementData(element);
                element.classList.toggle('is-selected', Boolean(anchor
                    && mapped.side === anchor.side
                    && mapped.endLine >= anchor.startLine
                    && mapped.startLine <= anchor.endLine));
            });
        },
        paintComments(comments) {
            leaves().forEach(element => {
                const mapped = mappedElementData(element);
                const anchored = comments.filter(comment => comment.side === mapped.side
                    && comment.endLine >= mapped.startLine
                    && comment.startLine <= mapped.endLine);
                element.classList.toggle('has-comment', anchored.length > 0);
                if (anchored.length > 0) {
                    element.setAttribute('aria-describedby', anchored.map(comment => `comment-list-${comment.id}`).join(' '));
                } else {
                    element.removeAttribute('aria-describedby');
                }
            });
        },
    };
}

let commentSeq = 0;
function nextCommentId() {
    commentSeq += 1;
    return `c${commentSeq}`;
}

/**
 * Client-side mirror of the server's A-5 rule. The server stays authoritative;
 * this exists so the human is told before a round trip, not after.
 */
export function validateVerdict(verdict, overallFeedback, inlineComments) {
    if (verdict !== 'changes_requested' && verdict !== 'rejected') return null;
    const hasFeedback = (overallFeedback || '').trim().length > 0;
    const hasComments = Array.isArray(inlineComments) && inlineComments.length > 0;
    if (hasFeedback || hasComments) return null;
    const label = verdict === 'rejected' ? 'Reject' : 'Request changes';
    return `${label} needs a reason — add overall feedback or at least one inline comment.`;
}

/**
 * Stable ordering for the submitted payload, mirroring the server's sort so the
 * two agree byte-for-byte regardless of the order comments were typed in.
 */
export function sortComments(comments) {
    return comments.slice().sort((a, b) =>
        (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
        a.startLine - b.startLine ||
        a.endLine - b.endLine ||
        (a.side < b.side ? -1 : a.side > b.side ? 1 : 0));
}

/**
 * Render a full-window state panel. Used for the states that arrive with no
 * reviewable body at all, so there is never a blank window (C-4, A-7).
 *
 * `state.kind` is either 'upgrade-required' (decided client-side from
 * protocolVersion) or one of the `_error.kind` contract strings Rust sends:
 * 'expired' | 'hash_mismatch' | 'decrypt' | 'corrupt' | 'missing' | 'unavailable'.
 *
 * Only 'expired' is the C-4 "ask the agent to resend" case. Every other kind is
 * a visible refusal: the plan is not shown, because a plan we cannot vouch for
 * is worse than no plan — approving the wrong bytes is the failure this whole
 * feature exists to prevent.
 */
export function renderReviewPanel(container, state) {
    clearMappedController(container);
    const kind = state?.kind || 'error';
    let icon = '⚠️';
    let title = 'Something went wrong';
    let detail = state?.message || '';

    if (kind === 'expired') {
        icon = '⌛';
        title = 'Plan expired';
        detail = detail || 'This review’s attachment is no longer on the server. '
            + 'ntfy keeps messages for 12 hours but their attachments for only 3 — '
            + 'ask the agent to resend the plan.';
    } else if (kind === 'hash_mismatch') {
        icon = '🛑';
        title = 'Plan does not match its hash';
        detail = 'The plan that arrived is not the plan the agent said it sent. '
            + 'It has not been shown, and nothing can be approved from here. '
            + 'Ask the agent to resend, and treat this as suspicious if it repeats.';
    } else if (kind === 'decrypt') {
        icon = '🔒';
        title = 'Could not decrypt the plan';
        detail = 'This plan was encrypted with a key this device does not have. '
            + 'Check that both ends share the same HITL encryption key.';
    } else if (kind === 'corrupt') {
        icon = '🛑';
        title = 'Plan is unreadable';
        detail = detail || 'The plan arrived malformed and could not be parsed. Ask the agent to resend it.';
    } else if (kind === 'missing') {
        icon = '⌛';
        title = 'Plan content is missing';
        detail = detail || 'The review arrived without its plan body. Ask the agent to resend it.';
    } else if (kind === 'unavailable') {
        icon = '📡';
        title = 'Could not fetch the plan';
        detail = detail || 'The plan body could not be downloaded. Check your connection and ask the agent to resend.';
    } else if (kind === 'upgrade-required') {
        icon = '⬆️';
        title = 'Needs a newer HITL client';
        const have = state?.have ?? 'unknown';
        const need = state?.need ?? 'unknown';
        detail = `This message uses wire protocol version ${escapeHtml(String(need))}, but this `
            + `client only understands version ${escapeHtml(String(have))}. Update the HITL client to review it.`;
    }

    container.innerHTML = `
        <div class="review-panel" data-state="${escapeHtml(kind)}">
            <div class="review-panel-icon">${icon}</div>
            <h2 class="review-panel-title">${escapeHtml(title)}</h2>
            <p class="review-panel-detail">${kind === 'upgrade-required' ? detail : escapeHtml(detail)}</p>
            ${state?.displayPath ? `<p class="review-panel-path">${escapeHtml(state.displayPath)}</p>` : ''}
        </div>
    `;
}

/**
 * Render the plan-review window.
 *
 * @param {HTMLElement} container
 * @param {object} planMessage  a plan_review message whose `body` has already
 *        been decoded to `{content, diff}` by the caller.
 * @param {object} callbacks
 *        onSubmit({verdict, overallFeedback, inlineComments, reviewId, snapshotHash}) → Promise
 *        onSkip() → Promise
 *        onCancel() → Promise            (human closes / cancels the review)
 *        onDraftChange(draft)            (optional, fired on every edit)
 *        onReceived()                    (optional, fired only on a confirmed submit)
 *        onOpenExternal(url)             (optional, click-to-load image fallback)
 * @returns a controller for the states that arrive after first paint.
 */
export function renderPlanReview(container, planMessage, callbacks = {}) {
    clearMappedController(container);
    const lifecycleAbort = new AbortController();
    const msg = planMessage || {};
    const body = msg.body && typeof msg.body === 'object' ? msg.body : {};
    const content = typeof body.content === 'string' ? body.content : (msg.content || '');
    const diff = typeof body.diff === 'string' ? body.diff : (msg.diff || '');
    const displayPath = msg.displayPath || '';
    const reviewId = msg.messageId || '';
    const snapshotHash = msg.snapshotHash || '';

    const rows = diff ? parseDiff(diff) : rowsFromContent(content);
    const md = createMarkdownRenderer();
    const tFormatted = performance.now();
    const reconstructed = reconstructReviewDocuments(content, diff);
    const formattedModel = md
        ? createFormattedModel(md, reconstructed, callbacks.formattedDiffBounds || {})
        : { ok: false, reason: 'The Markdown renderer is unavailable.',
            oldDocument: { blocks: [] }, newDocument: { blocks: [] }, hunks: [] };
    const formattedBuildMs = performance.now() - tFormatted;

    /** @type {{id:string,path:string,startLine:number,endLine:number,side:string,comment:string}[]} */
    let comments = [];
    /** @type {{side:string, anchor:number, focus:number}|null} */
    let selection = null;
    let submitting = false;
    // Set when persisting the draft has actually failed, so the D-3 banner does
    // not promise a save that did not happen.
    let draftSaveFailed = false;
    let resolved = false;   // superseded or cancelled — verdict controls disabled

    const perf = { initialRenderMs: 0, markdownRenderMs: 0, formattedBuildMs,
        formattedParseMs: formattedModel.parseMs || 0,
        formattedDiffMs: formattedModel.diffMs || 0,
        formattedDomRenderMs: 0, lastModeDomRenderMs: 0, lastSelectionMapMs: 0,
        lastMappedLeafCount: 0,
        lastCommentUpdateMs: 0, rowCount: rows.length,
        formattedBlockCount: (formattedModel.oldDocument?.blocks?.length || 0)
            + (formattedModel.newDocument?.blocks?.length || 0),
        formattedFallback: !formattedModel.ok };
    window.__reviewPerf = perf;

    // ── shell ────────────────────────────────────────────────────────────────
    // Flexbox column: header → panes row → footer. Deliberately NOT the
    // `position:absolute; bottom:72px` pattern at styles.css:73 — that
    // hard-coded offset is the E-12 defect.
    //
    // The footer lives OUTSIDE the scrolling plan container, so plan content
    // cannot paint over the verdict buttons no matter what it contains (F-5).
    const badges = [];
    if (msg.repo?.name) badges.push(`<span class="badge"><span class="badge-icon">📁</span> ${escapeHtml(msg.repo.name)}</span>`);
    if (msg.repo?.branch) badges.push(`<span class="badge"><span class="badge-icon">🌿</span> ${escapeHtml(msg.repo.branch)}</span>`);
    if (msg.sender?.label) badges.push(`<span class="badge badge-sender" title="${escapeHtml(msg.sender.label)}">${escapeHtml(msg.sender.label)}</span>`);
    badges.push(`<span class="badge badge-rev">${msg.isNewPlan ? 'New plan' : `Revision ${escapeHtml(String(msg.revision ?? 1))}`}</span>`);

    container.innerHTML = `
        <div class="review-root">
            <header class="review-header">
                <div class="review-titlebar">
                    <button class="review-header-toggle" id="review-header-toggle"
                            aria-expanded="true" aria-controls="review-header-body"
                            title="Hide the plan details">
                        <span class="arrow open" id="review-header-arrow">▶</span>
                        <span class="review-title">Plan review</span>
                    </button>
                    <div class="review-find">
                        <input type="search" id="review-find-input" class="review-find-input"
                               placeholder="Find in plan (Ctrl+F)" aria-label="Find in plan">
                        <span class="review-find-count" id="review-find-count"></span>
                        <button class="review-find-btn" id="review-find-prev" title="Previous match" aria-label="Previous match">↑</button>
                        <button class="review-find-btn" id="review-find-next" title="Next match" aria-label="Next match">↓</button>
                    </div>
                </div>
                <div class="review-header-body" id="review-header-body">
                    <div class="review-meta">
                        <span class="review-path" title="${escapeHtml(displayPath)}">${escapeHtml(displayPath)}</span>
                        <span class="review-badges">${badges.join('')}</span>
                    </div>
                    ${msg.summary ? `<div class="review-summary md-content" id="review-summary"></div>` : ''}
                    ${msg.context ? `
                    <div class="review-context">
                        <button class="review-context-toggle" id="review-context-toggle" aria-expanded="false">
                            <span class="arrow" id="review-context-arrow">▶</span> Why the agent is asking
                        </button>
                        <div class="review-context-body" id="review-context-body" style="display:none;">
                            <div class="md-content" id="review-context-content"></div>
                        </div>
                    </div>` : ''}
                </div>
                <!-- Outside the collapsible block on purpose: a superseded or
                     cancelled review that silently stops saying so is the worst
                     thing this pane can do. -->
                <div class="review-banners" id="review-banners"></div>
            </header>

            <div class="review-body">
            <section class="review-pane review-pane-rendered" id="review-pane-rendered"
                     aria-label="Plan review document">
                <div class="review-pane-label review-rendered-toolbar">
                    <div class="review-view-tabs" role="tablist" aria-label="Review view">
                        <button type="button" role="tab" id="review-tab-changes"
                                aria-controls="review-panel-changes" aria-selected="true">Changes</button>
                        <button type="button" role="tab" id="review-tab-before-after"
                                aria-controls="review-pane-before-after" aria-selected="false" tabindex="-1">Before &amp; after</button>
                        <button type="button" role="tab" id="review-tab-source"
                                aria-controls="review-pane-diff" aria-selected="false" tabindex="-1">Source</button>
                    </div>
                    <div class="review-change-nav" aria-label="Change navigation">
                        <button type="button" aria-label="Previous change">↑</button>
                        <button type="button" aria-label="Next change">↓</button>
                    </div>
                    <button class="rendered-selection-action" id="comment-rendered-selection"
                            type="button" disabled>Comment on selection</button>
                </div>
                <div class="review-view-status" id="review-view-status" role="status" aria-live="polite"></div>
                <div class="review-view-panels">
                    <div class="review-view-panel" id="review-panel-changes" role="tabpanel"
                         aria-labelledby="review-tab-changes">
                        <div class="md-content formatted-changes" id="rendered-content"></div>
                    </div>
                    <div class="review-view-panel" id="review-pane-before-after" role="tabpanel"
                         aria-labelledby="review-tab-before-after" hidden>
                        <div class="before-after-toggle" role="group" aria-label="Comparison side">
                            <button type="button" data-comparison-side="before" aria-pressed="true">Before</button>
                            <button type="button" data-comparison-side="after" aria-pressed="false">After</button>
                        </div>
                        <div class="before-after-grid">
                            <section class="before-after-side" aria-label="Before">
                                <h2 class="before-after-heading">Before</h2>
                                <div class="md-content" id="before-content"></div>
                            </section>
                            <section class="before-after-side" aria-label="After">
                                <h2 class="before-after-heading">After</h2>
                                <div class="md-content" id="after-content"></div>
                            </section>
                        </div>
                    </div>
                    <section class="review-view-panel review-pane-diff" id="review-pane-diff"
                             role="tabpanel" aria-labelledby="review-tab-source" aria-label="Plan source with line numbers" hidden>
                        <div class="review-pane-label">Source · click a line, shift-click another to select a range</div>
                        <div class="diff-rows" id="diff-rows" tabindex="0" role="list"></div>
                    </section>
                </div>
            </section>
                <aside class="review-comments" aria-label="Inline comments">
                    <div class="review-pane-label">
                        Comments <span class="comment-count" id="comment-count">0</span>
                    </div>
                    <div class="comment-list" id="comment-list"></div>
                </aside>
            </div>

            <footer class="review-footer">
                <div class="review-error" id="review-error" role="alert"></div>
                <label class="review-feedback-label" for="overall-feedback">Overall feedback</label>
                <textarea class="review-feedback" id="overall-feedback" rows="2"
                    placeholder="Optional for Approve. Required for Request changes / Reject unless you left inline comments."></textarea>
                <div class="review-actions">
                    <button class="button button-secondary" id="btn-skip">Skip</button>
                    <button class="button button-danger" id="btn-reject" data-verdict="rejected">Reject</button>
                    <button class="button button-warning" id="btn-request-changes" data-verdict="changes_requested">Request changes</button>
                    <button class="button button-primary" id="btn-approve" data-verdict="approved">Approve</button>
                </div>
            </footer>
        </div>
    `;

    const diffRowsEl = container.querySelector('#diff-rows');
    const diffPaneEl = container.querySelector('#review-pane-diff');
    const renderedPaneEl = container.querySelector('#review-pane-rendered');
    const renderedEl = container.querySelector('#rendered-content');
    const beforeEl = container.querySelector('#before-content');
    const afterEl = container.querySelector('#after-content');
    const formattedRootEl = container.querySelector('.review-view-panels');
    const renderedSelectionAction = container.querySelector('#comment-rendered-selection');
    const viewStatusEl = container.querySelector('#review-view-status');
    const commentListEl = container.querySelector('#comment-list');
    const commentCountEl = container.querySelector('#comment-count');
    const bannersEl = container.querySelector('#review-banners');
    const errorEl = container.querySelector('#review-error');
    const feedbackEl = container.querySelector('#overall-feedback');
    let mappedController = null;
    let sourceRendered = false;

    // ── rendered pane (read-only in v1) ──────────────────────────────────────
    function renderMarkdownInto(el, text, mapped = false) {
        if (!el) return;
        if (md) {
            el.innerHTML = mapped ? renderMappedMarkdown(md, text, 'new') : md.render(text || '');
        } else {
            // markdown-it missing — degrade to escaped text rather than to raw HTML.
            el.textContent = text || '';
        }
    }
    const tMd = performance.now();
    const collapsedRuns = new Map();
    renderedEl.innerHTML = renderChangesHtml(formattedModel, collapsedRuns);
    const changedOld = new Map((formattedModel.hunks || [])
        .flatMap(hunk => hunk.removed.map(block => [block, hunk.id])));
    const changedNew = new Map((formattedModel.hunks || [])
        .flatMap(hunk => hunk.added.map(block => [block, hunk.id])));
    let beforeAfterRendered = false;
    function ensureBeforeAfterRendered() {
        if (beforeAfterRendered) return;
        const started = performance.now();
        beforeEl.innerHTML = renderBeforeAfterDocument(formattedModel.oldDocument, 'removed', changedOld);
        afterEl.innerHTML = renderBeforeAfterDocument(formattedModel.newDocument, 'added', changedNew);
        perf.lastModeDomRenderMs = performance.now() - started;
        beforeAfterRendered = true;
        mappedController?.paintComments(comments);
        mappedController?.paintSelection(selectionAnchorObject());
    }
    if (!formattedModel.ok) {
        ensureBeforeAfterRendered();
        // Keep Task 10's stable `#rendered-content` contract on the visible
        // current document even when Changes itself cannot be constructed.
        renderedEl.replaceChildren();
        renderedEl.id = 'formatted-changes-unavailable';
        afterEl.id = 'rendered-content';
        viewStatusEl.textContent = 'Formatted Changes could not be built for this plan. '
            + 'Showing Before & after; Source is still available.';
        const changesTab = container.querySelector('#review-tab-changes');
        changesTab.disabled = true;
        changesTab.setAttribute('aria-describedby', 'review-view-status');
    }
    perf.markdownRenderMs = performance.now() - tMd;
    perf.formattedDomRenderMs = perf.markdownRenderMs;
    if (msg.summary) renderMarkdownInto(container.querySelector('#review-summary'), msg.summary);
    if (msg.context) renderMarkdownInto(container.querySelector('#review-context-content'), msg.context);

    // The header is ~173px of chrome sitting above a pane whose whole job is to
    // show as much of the plan as it can. Collapsing it hands that back.
    //
    // The titlebar deliberately stays: it carries "Find in plan", and in the
    // popup client `review.js` is the entire window, so there is nowhere else
    // for search to go. Remembered rather than reset per review, because a
    // reader who collapsed it once means it for the next plan too.
    const HEADER_COLLAPSED_KEY = 'review.headerCollapsed';
    const headerToggle = container.querySelector('#review-header-toggle');
    const headerBody = container.querySelector('#review-header-body');

    function setHeaderCollapsed(collapsed) {
        if (!headerToggle || !headerBody) return;
        headerBody.hidden = collapsed;
        headerToggle.setAttribute('aria-expanded', String(!collapsed));
        headerToggle.title = collapsed ? 'Show the plan details' : 'Hide the plan details';
        container.querySelector('#review-header-arrow')?.classList.toggle('open', !collapsed);
    }

    try {
        setHeaderCollapsed(localStorage.getItem(HEADER_COLLAPSED_KEY) === '1');
    } catch {
        // A private window, cleared site data, or a browser set to refuse
        // storage. None of those are a reason to fail to draw the reviewer.
        setHeaderCollapsed(false);
    }

    headerToggle?.addEventListener('click', () => {
        const collapsed = headerBody.hidden !== true;
        setHeaderCollapsed(collapsed);
        try {
            localStorage.setItem(HEADER_COLLAPSED_KEY, collapsed ? '1' : '0');
        } catch {
            // Losing the memory of the choice must not lose the choice itself.
        }
    });

    container.querySelector('#review-context-toggle')?.addEventListener('click', () => {
        const bodyEl = container.querySelector('#review-context-body');
        const arrow = container.querySelector('#review-context-arrow');
        const hidden = bodyEl.style.display === 'none';
        bodyEl.style.display = hidden ? 'block' : 'none';
        arrow?.classList.toggle('open', hidden);
        container.querySelector('#review-context-toggle')?.setAttribute('aria-expanded', String(hidden));
    });

    // One view at a time: formatted changes by default, full documents for
    // broader context, and the original line-addressable Source as the syntax
    // escape hatch. The choice lives only for this open review.
    const viewTabs = Array.from(container.querySelectorAll('.review-view-tabs [role="tab"]'));
    const viewPanels = {
        changes: container.querySelector('#review-panel-changes'),
        'before-after': container.querySelector('#review-pane-before-after'),
        source: container.querySelector('#review-pane-diff'),
    };
    let viewMode = 'changes';
    let rerunFindForView = () => {};

    function setViewMode(mode, focusTab = false) {
        if (!viewPanels[mode]) return;
        if (mode === 'before-after') ensureBeforeAfterRendered();
        if (mode === 'source') ensureSourceRendered();
        viewMode = mode;
        for (const [key, panel] of Object.entries(viewPanels)) panel.hidden = key !== mode;
        for (const tab of viewTabs) {
            const selected = tab.id === `review-tab-${mode}`;
            tab.setAttribute('aria-selected', String(selected));
            tab.tabIndex = selected ? 0 : -1;
            if (selected && focusTab) tab.focus();
        }
        renderedSelectionAction.hidden = mode === 'source';
        container.querySelector('.review-change-nav').hidden = mode === 'source'
            || (formattedModel.hunks || []).length === 0;
        mappedController?.clearCandidate();
        rerunFindForView();
    }

    viewTabs.forEach(tab => tab.addEventListener('click', () => {
        setViewMode(tab.id.replace('review-tab-', ''));
    }));
    container.querySelector('.review-view-tabs')?.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const navigableTabs = viewTabs.filter(tab => !tab.disabled);
        const current = Math.max(0, navigableTabs.indexOf(event.target.closest('[role="tab"]')));
        const next = event.key === 'Home' ? 0
            : event.key === 'End' ? navigableTabs.length - 1
            : (current + (event.key === 'ArrowRight' ? 1 : -1) + navigableTabs.length) % navigableTabs.length;
        navigableTabs[next].click();
        navigableTabs[next].focus();
    });
    setViewMode(formattedModel.ok ? 'changes' : 'before-after');

    const comparisonGrid = container.querySelector('.before-after-grid');
    const setComparisonSide = side => {
        comparisonGrid.dataset.narrowSide = side;
        container.querySelectorAll('[data-comparison-side]').forEach(candidate => {
            candidate.setAttribute('aria-pressed', String(candidate.dataset.comparisonSide === side));
        });
    };
    container.querySelectorAll('[data-comparison-side]').forEach(button => {
        button.addEventListener('click', () => {
            setComparisonSide(button.dataset.comparisonSide);
        });
    });
    // A failed reconstruction has no trustworthy previous document. On a
    // narrow host, show the authoritative current plan rather than an empty or
    // unavailable Before side while hiding the useful content behind a toggle.
    setComparisonSide(!formattedModel.ok || formattedModel.oldDocument.blocks.length === 0
        ? 'after' : 'before');

    let activeHunkIndex = -1;
    const comparisonTargetSide = target => target?.closest('.before-after-side')
        ?.getAttribute('aria-label')?.toLowerCase();
    function revealNarrowComparisonTarget(target) {
        if (viewMode !== 'before-after' || !target) return;
        const toggle = container.querySelector('.before-after-toggle');
        if (getComputedStyle(toggle).display === 'none') return;
        const side = comparisonTargetSide(target);
        if (side === 'before' || side === 'after') setComparisonSide(side);
    }
    function focusChange(delta) {
        const hunks = viewMode === 'changes'
            ? Array.from(container.querySelectorAll('#rendered-content .formatted-hunk'))
            : (formattedModel.hunks || []).map(hunk => {
                const selectedSide = comparisonGrid.dataset.narrowSide === 'after' ? 'After' : 'Before';
                return container.querySelector(
                    `#review-pane-before-after .before-after-side[aria-label="${selectedSide}"] `
                    + `.formatted-change[data-change-hunk="${hunk.id}"]`)
                    || container.querySelector(
                        `#review-pane-before-after .formatted-change[data-change-hunk="${hunk.id}"]`);
            }).filter(Boolean);
        if (hunks.length === 0) return;
        activeHunkIndex = (activeHunkIndex + delta + hunks.length) % hunks.length;
        revealNarrowComparisonTarget(hunks[activeHunkIndex]);
        if (!hunks[activeHunkIndex].hasAttribute('tabindex')) hunks[activeHunkIndex].tabIndex = -1;
        hunks[activeHunkIndex].focus();
        hunks[activeHunkIndex].scrollIntoView({ block: 'center' });
    }
    container.querySelector('[aria-label="Previous change"]')?.addEventListener('click', () => focusChange(-1));
    container.querySelector('[aria-label="Next change"]')?.addEventListener('click', () => focusChange(1));

    function revealCollapsedRun(reveal, focus = true) {
        const collapsed = reveal?.closest('.formatted-unchanged-collapsed');
        if (!collapsed) return [];
        const blocks = collapsedRuns.get(reveal.dataset.collapsedRun) || [];
        const template = document.createElement('template');
        template.innerHTML = blocks.map(block => formattedBlockHtml(block, 'equal', '')).join('');
        const revealed = Array.from(template.content.children);
        collapsed.replaceWith(...revealed);
        collapsedRuns.delete(reveal.dataset.collapsedRun);
        if (focus) {
            const focusTarget = revealed.find(element => element.matches(MAPPED_BLOCK_SELECTOR)
                || element.querySelector(MAPPED_BLOCK_SELECTOR));
            const mapped = focusTarget?.matches(MAPPED_BLOCK_SELECTOR)
                ? focusTarget : focusTarget?.querySelector(MAPPED_BLOCK_SELECTOR);
            if (mapped) { mapped.tabIndex = -1; mapped.focus(); }
        }
        return revealed;
    }

    formattedRootEl.addEventListener('click', event => {
        const reveal = event.target.closest('.formatted-unchanged-reveal');
        if (reveal) {
            revealCollapsedRun(reveal);
            return;
        }
        const indicator = event.target.closest('.source-change-indicator');
        if (!indicator) return;
        const hunk = formattedModel.hunks.find(item => item.id === indicator.dataset.sourceHunk);
        const block = hunk?.removed[0] || hunk?.added[0];
        setViewMode('source', true);
        const row = block && diffRowsEl.querySelector(
            `.diff-row[data-side="${block.side}"][data-line="${block.startLine}"]`);
        row?.focus();
        row?.scrollIntoView({ block: 'center' });
    });

    // Click-to-load for remote images. Under the shipped CSP (`img-src 'self'
    // data:`) the load itself is blocked, so we fall back to offering the URL —
    // the point of F-7 is that nothing is fetched without an explicit human act.
    renderedPaneEl?.addEventListener('click', (e) => {
        const ph = e.target.closest('.md-image-placeholder');
        if (!ph) return;
        loadPlaceholderImage(ph);
    });
    renderedPaneEl?.addEventListener('keydown', (e) => {
        const ph = e.target.closest('.md-image-placeholder');
        if (!ph || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        loadPlaceholderImage(ph);
    });

    function loadPlaceholderImage(ph) {
        const src = ph.getAttribute('data-src') || '';
        if (callbacks.onOpenExternal) {
            // If handing off to the OS fails, fall back to loading in place
            // rather than leaving a click that visibly does nothing.
            let handed;
            try { handed = callbacks.onOpenExternal(src); } catch (err) { handed = Promise.reject(err); }
            if (handed && typeof handed.catch === 'function') {
                handed.catch(() => loadImageInPlace(ph, src));
            }
            return;
        }
        loadImageInPlace(ph, src);
    }

    function loadImageInPlace(ph, src) {
        if (!ph.isConnected) return;
        const img = document.createElement('img');
        img.className = 'md-image-loaded';
        img.alt = ph.querySelector('.md-image-alt')?.textContent || '';
        img.addEventListener('error', () => {
            // F-7 vs F-8: img-src 'self' data: blocks this by design. Say so,
            // and keep the URL visible as text so it is never hidden.
            const failed = document.createElement('span');
            failed.className = 'md-image-blocked';
            failed.textContent = `Image blocked by content policy: ${src}`;
            img.replaceWith(failed);
        });
        img.src = src;
        ph.replaceWith(img);
    }

    // ── diff pane ────────────────────────────────────────────────────────────
    function rowKey(side, line) { return `${side}:${line}`; }

    function commentsFor(side, line) {
        return comments.filter(c => c.side === side && line >= c.startLine && line <= c.endLine);
    }

    /** Comments whose anchor *ends* on this row — where the inline card mounts. */
    function commentsEndingAt(side, line) {
        return comments.filter(c => c.side === side && c.endLine === line);
    }

    function rowHtml(row, index) {
        if (row.kind === 'meta' || row.kind === 'hunk') {
            return `<div class="diff-row diff-row-${row.kind}" role="listitem" aria-hidden="true"
                ><span class="diff-gutter"></span><span class="diff-gutter"></span
                ><span class="diff-mark"></span><span class="diff-text">${escapeHtml(row.text)}</span></div>`;
        }
        const mark = row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' ';
        const anchored = commentsFor(row.side, row.line);
        const describedBy = anchored.map(c => `comment-${c.id}`).join(' ');
        const selected = isSelected(row.side, row.line) ? ' is-selected' : '';
        const commented = anchored.length ? ' has-comment' : '';
        const inline = commentsEndingAt(row.side, row.line).map(inlineCommentHtml).join('');
        return `<div class="diff-row diff-row-${row.kind}${selected}${commented}" role="listitem"
                data-line="${row.line}" data-side="${row.side}" data-index="${index}" tabindex="-1"
                ${describedBy ? `aria-describedby="${describedBy}"` : ''}
                aria-label="${row.side === 'old' ? 'Removed line' : 'Line'} ${row.line}"
            ><span class="diff-gutter diff-gutter-old">${row.oldLine ?? ''}</span
            ><span class="diff-gutter diff-gutter-new">${row.newLine ?? ''}</span
            ><span class="diff-mark">${mark}</span
            ><span class="diff-text">${escapeHtml(row.text)}</span></div>${inline}`;
    }

    function inlineCommentHtml(c) {
        return `<div class="comment-card comment-card-inline" id="comment-${c.id}" data-comment-id="${c.id}">
            <div class="comment-card-anchor">${escapeHtml(anchorLabel(c))}</div>
            <div class="comment-card-body">${escapeHtml(c.comment)}</div>
            <button class="comment-remove" data-remove="${c.id}" aria-label="Remove comment">Remove</button>
        </div>`;
    }

    function anchorLabel(c) {
        const range = c.startLine === c.endLine ? `line ${c.startLine}` : `lines ${c.startLine}–${c.endLine}`;
        return c.side === 'old' ? `${range} (removed)` : range;
    }

    /**
     * Naive full re-render of the diff pane.
     *
     * The design gate explicitly cut the overlay *mandate* (E-13/E-14) because no
     * benchmark showed naive re-render is slow: build this first, measure on a
     * real 100 KB plan, adopt an overlay only if it demonstrably lags. `perf`
     * records the cost of every comment add/remove so the number is observable.
     */
    function renderDiff() {
        const html = new Array(rows.length);
        for (let i = 0; i < rows.length; i++) html[i] = rowHtml(rows[i], i);
        diffRowsEl.innerHTML = html.join('');
    }

    function ensureSourceRendered() {
        if (sourceRendered) return;
        renderDiff();
        sourceRendered = true;
    }

    function renderCommentList() {
        // A rendered-selection composer lives inside the comment list. Keep the
        // exact form node across list updates so removing another comment cannot
        // erase its textarea value, selection, focus, or source anchor.
        const liveComposer = commentListEl.querySelector(':scope > #comment-composer');
        const focused = liveComposer?.contains(document.activeElement) ? document.activeElement : null;
        const focusSelection = focused instanceof HTMLTextAreaElement || focused instanceof HTMLInputElement
            ? { start: focused.selectionStart, end: focused.selectionEnd, direction: focused.selectionDirection }
            : null;
        const restoreComposerFocus = () => {
            if (!focused) return;
            focused.focus();
            if (focusSelection) focused.setSelectionRange(
                focusSelection.start, focusSelection.end, focusSelection.direction);
        };
        liveComposer?.remove();
        commentCountEl.textContent = String(comments.length);
        if (comments.length === 0) {
            commentListEl.innerHTML = '<p class="comment-empty">No inline comments yet. '
                + 'Select text in the rendered plan, or click lines in Source, then add a comment.</p>';
            if (liveComposer) commentListEl.prepend(liveComposer);
            restoreComposerFocus();
            return;
        }
        commentListEl.innerHTML = sortComments(comments).map(c => `
            <div class="comment-card comment-card-list" id="comment-list-${c.id}" data-comment-id="${c.id}">
                <button class="comment-card-anchor comment-jump" data-jump="${c.id}">${escapeHtml(anchorLabel(c))}</button>
                <div class="comment-card-body">${escapeHtml(c.comment)}</div>
                <button class="comment-remove" data-remove="${c.id}" aria-label="Remove comment">Remove</button>
            </div>
        `).join('');
        if (liveComposer) commentListEl.prepend(liveComposer);
        restoreComposerFocus();
    }

    function rerenderComments() {
        const t0 = performance.now();
        if (sourceRendered) renderDiff();
        renderCommentList();
        mappedController?.paintComments(comments);
        perf.lastCommentUpdateMs = performance.now() - t0;
        notifyDraft();
    }

    const t0 = performance.now();
    renderCommentList();
    perf.initialRenderMs = performance.now() - t0;

    // ── selection ────────────────────────────────────────────────────────────
    function isSelected(side, line) {
        if (!selection || selection.side !== side) return false;
        const lo = Math.min(selection.anchor, selection.focus);
        const hi = Math.max(selection.anchor, selection.focus);
        return line >= lo && line <= hi;
    }

    function selectionAnchorObject() {
        if (!selection) return null;
        return {
            path: displayPath,
            startLine: Math.min(selection.anchor, selection.focus),
            endLine: Math.max(selection.anchor, selection.focus),
            side: selection.side,
        };
    }

    function paintSelection() {
        diffRowsEl.querySelectorAll('.diff-row[data-line]').forEach(el => {
            const on = isSelected(el.dataset.side, parseInt(el.dataset.line, 10));
            el.classList.toggle('is-selected', on);
        });
        mappedController?.paintSelection(selectionAnchorObject());
        renderComposer();
    }

    function setSelection(side, line, extend) {
        if (!selection || selection.side !== side || selection.origin !== 'source' || !extend) {
            selection = { side, anchor: line, focus: line, origin: 'source' };
        } else {
            selection.focus = line;
        }
        paintSelection();
    }

    function clearSelection() {
        selection = null;
        paintSelection();
    }

    /**
     * The composer is mounted after the last row of the current selection.
     *
     * It is moved rather than rebuilt while a selection is being extended: a
     * rebuild would drop half-typed text, and auto-focusing it on every repaint
     * would steal focus mid shift+arrow and silently truncate the range (I-1).
     */
    function renderComposer(opts = {}) {
        const existing = container.querySelector('#comment-composer');
        if (!selection || resolved) { existing?.remove(); return; }
        const anchor = selectionAnchorObject();
        const renderedOrigin = selection.origin === 'rendered';
        const lastRow = diffRowsEl.querySelector(
            `.diff-row[data-side="${anchor.side}"][data-line="${anchor.endLine}"]`);
        if (!renderedOrigin && !lastRow) { existing?.remove(); return; }

        let composer = existing;
        if (!composer) {
            composer = document.createElement('div');
            composer.className = 'comment-composer';
            composer.id = 'comment-composer';
            composer.innerHTML = `
                <div class="composer-anchor"></div>
                <textarea class="composer-input" id="comment-input" rows="3"
                    placeholder="What is wrong with these lines?" aria-label="Comment text"></textarea>
                <div class="composer-actions">
                    <button class="button button-secondary" id="comment-cancel">Cancel</button>
                    <button class="button button-primary" id="comment-add">Add comment</button>
                </div>
            `;
            composer.querySelector('#comment-input').addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); addComment(); }
                if (e.key === 'Escape') { e.preventDefault(); clearSelection(); }
            });
            composer.querySelector('#comment-add').addEventListener('click', addComment);
            composer.querySelector('#comment-cancel').addEventListener('click', clearSelection);
        }
        composer.querySelector('.composer-anchor').textContent = `Commenting on ${anchorLabel(anchor)}`;
        composer.classList.toggle('comment-composer-rendered', renderedOrigin);
        if (renderedOrigin) {
            if (composer.parentElement !== commentListEl || composer !== commentListEl.firstElementChild) {
                commentListEl.prepend(composer);
            }
        } else if (composer.previousElementSibling !== lastRow) {
            lastRow.after(composer);
        }
        if (opts.focus) composer.querySelector('#comment-input').focus();
    }

    function addComment() {
        const input = container.querySelector('#comment-input');
        const text = (input?.value || '').trim();
        const anchor = selectionAnchorObject();
        if (!anchor) return;
        if (!text) { showError('Comment text cannot be empty.'); input?.focus(); return; }
        comments.push({ id: nextCommentId(), ...anchor, comment: text });
        selection = null;
        clearError();
        rerenderComments();
    }

    function removeComment(id) {
        comments = comments.filter(c => c.id !== id);
        rerenderComments();
    }

    mappedController = createMappedDocumentController(
        formattedRootEl,
        renderedSelectionAction,
        anchor => {
            if (resolved) return;
            selection = {
                side: anchor.side,
                anchor: anchor.startLine,
                focus: anchor.endLine,
                origin: 'rendered',
            };
            paintSelection();
            renderComposer({ focus: true });
        },
        duration => { perf.lastSelectionMapMs = duration; },
        count => { perf.lastMappedLeafCount = count; },
    );
    mappedControllerCleanup.set(container, () => {
        mappedController.destroy();
        lifecycleAbort.abort();
    });
    mappedController.paintComments(comments);

    diffRowsEl.addEventListener('click', (e) => {
        const removeBtn = e.target.closest('[data-remove]');
        if (removeBtn) { removeComment(removeBtn.dataset.remove); return; }
        if (e.target.closest('.comment-composer')) return;
        const row = e.target.closest('.diff-row[data-line]');
        if (!row || resolved) return;
        mappedController.clearCandidate();
        setSelection(row.dataset.side, parseInt(row.dataset.line, 10), e.shiftKey);
        row.focus();
    });

    commentListEl.addEventListener('click', (e) => {
        const removeBtn = e.target.closest('[data-remove]');
        if (removeBtn) { removeComment(removeBtn.dataset.remove); return; }
        const jump = e.target.closest('[data-jump]');
        if (jump) {
            const comment = comments.find(item => item.id === jump.dataset.jump);
            if (!comment) return;
            if (viewMode === 'source') {
                const row = diffRowsEl.querySelector(
                    `.diff-row[data-side="${comment.side}"][data-line="${comment.startLine}"]`);
                row?.focus();
                row?.scrollIntoView({ block: 'center' });
                return;
            }
            const findMappedTarget = panel => mappedLeafElements(panel)
                .filter(element => {
                    const mapped = mappedElementData(element);
                    return mapped.side === comment.side
                        && mapped.endLine >= comment.startLine
                        && mapped.startLine <= comment.endLine;
                })
                .sort((a, b) => {
                    const am = mappedElementData(a);
                    const bm = mappedElementData(b);
                    return (am.endLine - am.startLine) - (bm.endLine - bm.startLine);
                })[0];
            let target = findMappedTarget(viewPanels[viewMode]);
            if (!target) {
                setViewMode('before-after');
                comparisonGrid.dataset.narrowSide = comment.side === 'old' ? 'before' : 'after';
                container.querySelectorAll('[data-comparison-side]').forEach(button => {
                    button.setAttribute('aria-pressed', String(button.dataset.comparisonSide
                        === comparisonGrid.dataset.narrowSide));
                });
                target = findMappedTarget(viewPanels['before-after']);
            }
            if (target) {
                target.tabIndex = -1;
                target.focus();
                target.scrollIntoView({ block: 'center' });
            }
        }
    });

    // I-1: full keyboard range selection. Arrow keys move, Shift+arrow extends,
    // Enter opens the composer — the same anchor a click + shift-click produces.
    diffRowsEl.addEventListener('keydown', (e) => {
        if (resolved) return;
        if (e.target.closest('.comment-composer')) return;
        const current = e.target.closest('.diff-row[data-line]')
            || diffRowsEl.querySelector('.diff-row[data-line].is-selected')
            || diffRowsEl.querySelector('.diff-row[data-line]');
        if (!current) return;

        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const next = e.key === 'ArrowDown' ? nextRowEl(current) : prevRowEl(current);
            if (!next) return;
            setSelection(next.dataset.side, parseInt(next.dataset.line, 10), e.shiftKey);
            next.focus();
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (!selection) setSelection(current.dataset.side, parseInt(current.dataset.line, 10), false);
            renderComposer({ focus: true });
        } else if (e.key === 'Escape') {
            clearSelection();
        }
    });

    // Tab into the pane lands on a row rather than nowhere.
    diffRowsEl.addEventListener('focus', () => {
        if (diffRowsEl.querySelector('.diff-row[data-line]:focus')) return;
        const target = diffRowsEl.querySelector('.diff-row[data-line].is-selected')
            || diffRowsEl.querySelector('.diff-row[data-line]');
        target?.focus();
    });

    /**
     * Neighbouring row on the same side. Shift+arrow must extend within one
     * coordinate space — 'old' lines only exist in the pre-image, so a range
     * never straddles the two sides.
     */
    function nextRowEl(el) {
        let n = el.nextElementSibling;
        while (n && !(n.matches('.diff-row[data-line]') && n.dataset.side === el.dataset.side)) n = n.nextElementSibling;
        return n;
    }
    function prevRowEl(el) {
        let n = el.previousElementSibling;
        while (n && !(n.matches('.diff-row[data-line]') && n.dataset.side === el.dataset.side)) n = n.previousElementSibling;
        return n;
    }

    // ── scroll sync ──────────────────────────────────────────────────────────
    let syncing = false;
    function syncFrom(source, target) {
        if (syncing) return;
        syncing = true;
        const range = source.scrollHeight - source.clientHeight;
        const ratio = range > 0 ? source.scrollTop / range : 0;
        target.scrollTop = ratio * (target.scrollHeight - target.clientHeight);
        requestAnimationFrame(() => { syncing = false; });
    }
    diffPaneEl.addEventListener('scroll', () => syncFrom(diffPaneEl, renderedPaneEl));
    renderedPaneEl.addEventListener('scroll', () => syncFrom(renderedPaneEl, diffPaneEl));

    // ── find in page (I-2) ───────────────────────────────────────────────────
    // A Tauri webview has no native Ctrl+F even with decorations on, and a
    // 100 KB plan is unusable without one.
    let findMatches = [];
    let findIndex = -1;
    const findInput = container.querySelector('#review-find-input');
    const findCountEl = container.querySelector('#review-find-count');

    function runFind() {
        formattedRootEl.querySelectorAll('.is-find-match, .is-find-current')
            .forEach(el => el.classList.remove('is-find-match', 'is-find-current'));
        const needle = (findInput.value || '').toLowerCase();
        findMatches = [];
        findIndex = -1;
        if (needle) {
            if (viewMode === 'changes') {
                // Equal context is collapsed by complete Markdown block, but
                // Find must still search the document rather than just the
                // currently materialized DOM. Reveal only runs that contain a
                // match, then use the normal mapped-node path below.
                for (const [collapsedId, blocks] of Array.from(collapsedRuns.entries())) {
                    if (!blocks.some(block => block.visibleText.toLowerCase().includes(needle))) continue;
                    const reveal = formattedRootEl.querySelector(
                        `.formatted-unchanged-reveal[data-collapsed-run="${collapsedId}"]`);
                    revealCollapsedRun(reveal, false);
                }
            }
            const activePanel = viewPanels[viewMode];
            const candidates = viewMode === 'source'
                ? activePanel.querySelectorAll('.diff-row')
                : mappedLeafElements(activePanel);
            candidates.forEach(el => {
                const text = viewMode === 'source'
                    ? el.querySelector('.diff-text')?.textContent || ''
                    : el.textContent || '';
                if (text.toLowerCase().includes(needle)) {
                    el.classList.add('is-find-match');
                    findMatches.push(el);
                }
            });
        }
        findCountEl.textContent = needle ? `${findMatches.length ? 1 : 0}/${findMatches.length}` : '';
        if (findMatches.length) stepFind(0);
    }
    rerunFindForView = runFind;
    function stepFind(delta) {
        if (!findMatches.length) return;
        findMatches[findIndex]?.classList.remove('is-find-current');
        findIndex = findIndex < 0 ? 0 : (findIndex + delta + findMatches.length) % findMatches.length;
        const el = findMatches[findIndex];
        revealNarrowComparisonTarget(el);
        el.classList.add('is-find-current');
        el.scrollIntoView({ block: 'center' });
        findCountEl.textContent = `${findIndex + 1}/${findMatches.length}`;
    }
    findInput.addEventListener('input', runFind);
    findInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); }
        if (e.key === 'Escape') { findInput.value = ''; runFind(); }
    });
    container.querySelector('#review-find-next').addEventListener('click', () => stepFind(1));
    container.querySelector('#review-find-prev').addEventListener('click', () => stepFind(-1));
    document.addEventListener('keydown', (e) => {
        // Parked Inbox panes deliberately retain their exact DOM and draft,
        // but a detached review must not take over global shortcuts.
        if (!findInput.isConnected) return;
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
            e.preventDefault();
            findInput.focus();
            findInput.select();
        }
    }, { signal: lifecycleAbort.signal });

    // ── banners, errors, drafts ──────────────────────────────────────────────
    function showError(message) {
        errorEl.textContent = message;
        errorEl.dataset.tone = 'error';
        errorEl.style.display = 'block';
    }
    /** Same slot, different tone: an in-flight submit, or a delivered-but-unconfirmed one. */
    function showNotice(message, tone) {
        errorEl.textContent = message;
        errorEl.dataset.tone = tone;
        errorEl.style.display = 'block';
    }
    function clearError() {
        errorEl.textContent = '';
        errorEl.dataset.tone = 'error';
        errorEl.style.display = 'none';
    }
    clearError();

    function showBanner(kind, text) {
        let el = bannersEl.querySelector(`[data-banner="${kind}"]`);
        if (!el) {
            el = document.createElement('div');
            el.className = `review-banner review-banner-${kind}`;
            el.setAttribute('data-banner', kind);
            el.setAttribute('role', 'status');
            bannersEl.appendChild(el);
        }
        el.textContent = text;
    }

    function currentDraft() {
        return {
            reviewId,
            planId: msg.planId || '',
            snapshotHash,
            overallFeedback: feedbackEl.value || '',
            inlineComments: sortComments(comments).map(({ id, ...rest }) => rest),
        };
    }
    function notifyDraft() {
        try { callbacks.onDraftChange?.(currentDraft()); } catch (err) { console.error('onDraftChange failed:', err); }
    }
    feedbackEl.addEventListener('input', notifyDraft);
    function setControlsDisabled(disabled) {
        container.querySelectorAll('.review-actions .button').forEach(b => { b.disabled = disabled; });
    }

    // ── submit ───────────────────────────────────────────────────────────────
    // C-6 / P3: app.js caught a failed submit with only console.error, so the
    // answer silently never left the machine. Here a failed submit shows an
    // error, keeps the window open, and preserves every typed comment.
    //
    // `submit_plan_review` blocks for up to 30 s waiting for the agent's ack, so
    // the outcome is three-valued and only one of them is success:
    //   received       → the agent has it; safe to show the terminal screen.
    //   lost           → published, but the agent will never read it. Re-offer.
    //   unacknowledged → published, unconfirmed. Keep everything, say so plainly.
    // A rejection means the publish itself failed and nothing was sent at all.
    function applySubmitResult(result, verdict) {
        // Fail safe: only a literal 'received' is success. An unknown status —
        // a newer client, a shape change, a missing field — is treated as
        // unacknowledged, because the cost of being wrong is asymmetric.
        // Guessing 'received' silently discards someone's review.
        const status = result?.status === 'received' ? 'received'
            : result?.status === 'lost' ? 'lost'
            : 'unacknowledged';
        if (status === 'received') {
            // Only here. On 'lost' or 'unacknowledged' the persisted draft is
            // the only surviving copy of the reviewer's work.
            try { callbacks.onReceived?.(); } catch (err) { console.error('onReceived failed:', err); }
            showSubmitted(container, verdict);
            return;
        }
        submitting = false;
        setControlsDisabled(false);
        notifyDraft();
        const because = result?.reason ? ` (${result.reason})` : '';
        if (status === 'lost') {
            showError(`The agent never received your review${because}. `
                + 'Everything you typed is still here — submit again.');
        } else {
            showNotice(`Your review was sent but the agent has not confirmed it${because}. `
                + 'Nothing here has been discarded. Wait for the agent, or submit again to re-send.', 'warning');
        }
    }

    async function submit(verdict) {
        if (submitting || resolved) return;
        const payload = {
            reviewId,
            snapshotHash,
            verdict,
            overallFeedback: (feedbackEl.value || '').trim(),
            inlineComments: sortComments(comments).map(({ id, ...rest }) => rest),
        };
        const problem = validateVerdict(verdict, payload.overallFeedback, payload.inlineComments);
        if (problem) { showError(problem); feedbackEl.focus(); return; }

        clearError();
        submitting = true;
        setControlsDisabled(true);
        // The call can sit for 30 s. Without this the window looks frozen and
        // the human starts clicking things that are already disabled.
        showNotice('Sending your review and waiting for the agent to confirm…', 'pending');
        try {
            applySubmitResult(await callbacks.onSubmit?.(payload), verdict);
        } catch (err) {
            submitting = false;
            setControlsDisabled(false);
            showError(`Submit failed — your review is intact, nothing was sent. ${err?.message || err}`);
        }
    }

    container.querySelectorAll('.review-actions [data-verdict]').forEach(btn => {
        btn.addEventListener('click', () => submit(btn.dataset.verdict));
    });
    container.querySelector('#btn-skip').addEventListener('click', async () => {
        if (submitting || resolved) return;
        submitting = true;
        setControlsDisabled(true);
        showNotice('Sending…', 'pending');
        try {
            applySubmitResult(await callbacks.onSkip?.(), 'skipped');
        } catch (err) {
            submitting = false;
            setControlsDisabled(false);
            showError(`Skip failed — your review is intact, nothing was sent. ${err?.message || err}`);
        }
    });

    // Guard against accidental keypresses when the window appears under the
    // cursor — same 500 ms footer guard as dialog.js:198-208 (E-10).
    let inputGuardActive = true;
    setTimeout(() => { inputGuardActive = false; }, 500);
    container.querySelector('.review-footer')?.addEventListener('keydown', (e) => {
        if (inputGuardActive && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            e.stopPropagation();
        }
    }, true);
    document.activeElement?.blur?.();

    // ── controller ───────────────────────────────────────────────────────────
    return {
        get comments() { return sortComments(comments).map(({ id, ...rest }) => rest); },
        get perf() { return perf; },
        getDraft: currentDraft,
        captureRecovery() {
            return {
                draft: currentDraft(),
                selection: selection ? { ...selection } : null,
                composerText: container.querySelector('#comment-input')?.value ?? '',
            };
        },
        restoreRecovery(recovery) {
            if (!recovery) return;
            this.restoreDraft(recovery.draft);
            selection = recovery.selection ? { ...recovery.selection } : null;
            renderComposer();
            const input = container.querySelector('#comment-input');
            if (input) input.value = recovery.composerText ?? '';
        },

        /** Another device reviewed first (D-5/D-6). Never closes, never destroys the draft. */
        setSuperseded(device) {
            resolved = true;
            mappedController.setResolved(true);
            setControlsDisabled(true);
            renderComposer();
            showBanner('superseded',
                `Already reviewed on ${device || 'another device'}. Your comments are kept here but will not be sent.`);
        },

        /** The agent exited (D-3). Comments stay on screen and go to the draft. */
        setCancelled(reason) {
            resolved = true;
            mappedController.setResolved(true);
            setControlsDisabled(true);
            renderComposer();
            notifyDraft();
            // `reason` is a free string on the wire, so this reads it rather
            // than switching on it exhaustively. The wording follows whether the
            // draft was actually persisted — claiming a save that failed is how
            // someone loses 20 minutes of review and only finds out later.
            const kept = draftSaveFailed
                ? 'Your comments are still here, but could not be saved as a draft — copy anything you need before closing.'
                : 'Your comments have been saved as a draft.';
            showBanner('cancelled', (reason === 'cancelled'
                ? 'This review was cancelled. '
                : 'The agent exited before this review finished. ') + kept);
        },

        /** Reported by the shell when persisting the draft failed. */
        noteDraftSaveFailed() {
            draftSaveFailed = true;
        },

        showError,
        restoreDraft(draft) {
            if (!draft) return;
            feedbackEl.value = draft.overallFeedback || '';
            comments = (draft.inlineComments || []).map(c => ({ id: nextCommentId(), ...c }));
            rerenderComments();
            // On a snapshot-hash mismatch the saved inline comments are dropped
            // deliberately: line anchors against changed content would attach
            // the reviewer's words to different text. Prose survives because it
            // is not anchored. Say so — comments disappearing with no
            // explanation reads as a bug and costs trust in the whole draft.
            if (draft.snapshotHash && snapshotHash && draft.snapshotHash !== snapshotHash) {
                showNotice('The plan changed since you last worked on this review. Your overall '
                    + 'feedback was restored, but your inline comments were not — their line '
                    + 'anchors no longer point at the same text.', 'warning');
            }
        },

        /** The submit was acknowledged; the shell may drop any persisted draft. */
        noteDraftClearFailed() {
            const panel = container.querySelector('.success-container') || container;
            if (panel.querySelector('.success-note')) return;
            const note = document.createElement('p');
            note.className = 'success-note';
            note.textContent = 'Your review was received, but the saved draft could not be cleared — '
                + 'you may be offered it again next time this plan comes round.';
            panel.appendChild(note);
        },
    };
}

/** Terminal success state, shown only after the submit actually succeeded. */
export function showSubmitted(container, verdict) {
    clearMappedController(container);
    const labels = {
        approved: 'Plan approved',
        changes_requested: 'Changes requested',
        rejected: 'Plan rejected',
        skipped: 'Review skipped',
    };
    container.innerHTML = `
        <div class="success-container">
            <div class="success-icon">✓</div>
            <h2 class="success-title">${escapeHtml(labels[verdict] || 'Review submitted')}</h2>
            <p class="success-subtitle">Sent to the agent. You can close this window now.</p>
        </div>
    `;
}
