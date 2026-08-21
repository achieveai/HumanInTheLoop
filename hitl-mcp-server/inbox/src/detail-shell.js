// The parts all three pane-3 renderers share (spec §8).
//
// Every renderer opens with the same block — title, status, who sent it, when,
// which repo — because a message in the Inbox has to identify itself without
// the pane-2 row that led you to it still being in view. Only what comes below
// that block differs by type.
//
// Built with DOM calls rather than template strings, matching pane-list.js.
// Titles, labels, responder names and context are all agent-authored text, and
// `textContent` cannot be talked into interpreting any of it as markup. The one
// place markdown is rendered goes through markdown-it with `html: false`, which
// drops raw HTML outright.

import { formatAbsolute, statusPill } from './pane-list.js';

/** Create an element, optionally with a class and text. */
export function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
}

let renderer;

/**
 * The shared markdown renderer.
 *
 * `html: false` is markdown-it's default and is load-bearing here for the same
 * reason it is in review.js: it drops raw HTML entirely, so a notification body
 * or a question option cannot paint a fake UI over the pane. Never enable it.
 *
 * Returns `null` when the vendored bundle is not on the page, which is the
 * signal to fall back to plain text rather than to raw HTML.
 */
export function markdown() {
    if (renderer !== undefined) return renderer;
    renderer = typeof window.markdownit === 'function'
        ? window.markdownit({ html: false, linkify: true, typographer: false })
        : null;
    return renderer;
}

/** Render markdown into a node, degrading to escaped text, never to raw HTML. */
export function renderMarkdownInto(node, text) {
    if (!node) return;
    const md = markdown();
    if (md) {
        node.innerHTML = md.render(String(text ?? ''));
    } else {
        node.textContent = String(text ?? '');
    }
}

/** An absolute local time, for the fixed header. */
export function formatWhen(unixSeconds) {
    return formatAbsolute(unixSeconds);
}

/**
 * The sender badge (spec §8.1).
 *
 * Carries the tier it was resolved at on `data-source`, so a `path`-tier
 * attribution — the weakest, and the one that lumps two worktrees of a repo
 * together — is distinguishable from a `session`-tier one instead of looking
 * equally authoritative.
 */
export function senderBadge(sender) {
    if (!sender?.label) return null;
    const badge = el('span', 'badge badge-sender', sender.label);
    badge.title = sender.source ? `${sender.label} (${sender.source})` : sender.label;
    if (sender.source) badge.dataset.source = sender.source;
    return badge;
}

/**
 * The block every renderer opens with.
 *
 * `kicker` names the message family in words, since the pane-2 glyph is not
 * in view here.
 */
export function detailHeader(detail, kicker) {
    const { row, sender } = detail;
    const header = el('header', 'detail-header');
    header.dataset.messageId = row.messageId;
    header.dataset.type = row.msgType;
    header.dataset.status = row.status;

    header.appendChild(el('div', 'detail-kicker', kicker));

    const line = el('div', 'detail-headline');
    line.appendChild(el('h2', 'detail-title', row.title));
    line.appendChild(statusPill(row));
    header.appendChild(line);

    const meta = el('div', 'detail-meta');
    const badge = senderBadge(sender);
    if (badge) meta.appendChild(badge);
    if (row.badges?.repo) meta.appendChild(el('span', 'badge badge-repo', row.badges.repo));
    if (row.badges?.revision) meta.appendChild(el('span', 'badge badge-revision', `r${row.badges.revision}`));
    if (row.badges?.plaintext === true) {
        meta.appendChild(el('span', 'badge badge-plaintext', 'plaintext'));
    }
    const when = el('span', 'detail-when', formatWhen(row.createdAt));
    when.dateTime = String(row.createdAt);
    meta.appendChild(when);
    header.appendChild(meta);

    const closed = closedLine(row);
    if (closed) header.appendChild(closed);

    return header;
}

/**
 * "Answered by Kay9 laptop · 12 Aug 2026, 10:32", when someone closed it.
 *
 * The verb follows the folded status rather than always reading "answered":
 * a dismissed notification was not answered, and a review whose agent exited
 * was closed by nobody at all.
 */
export function closedLine(row) {
    const VERBS = {
        answered: 'Answered by',
        skipped: 'Skipped by',
        dismissed: 'Dismissed by',
        lost: 'Answered first by',
    };

    if (row.status === 'cancelled') return el('p', 'detail-closed', 'Cancelled before anyone replied.');
    if (row.status === 'superseded') return el('p', 'detail-closed', 'Superseded by a newer revision.');
    if (row.status === 'agent_gone') {
        return el('p', 'detail-closed', 'The agent exited before this was answered.');
    }

    const verb = VERBS[row.status];
    if (!verb) return null;

    const line = el('p', 'detail-closed');
    line.appendChild(el('span', 'detail-closed-verb', verb));
    line.appendChild(el('span', 'detail-responder', row.responder || 'another device'));
    if (row.respondedAt) {
        line.appendChild(el('span', 'detail-closed-at', formatWhen(row.respondedAt)));
    }
    if (row.status === 'lost') {
        // Spec §9.3: this device's response was not the one the agent read.
        // Saying only "answered" here would let someone believe their own reply
        // is what the agent acted on.
        line.appendChild(el('span', 'detail-lost-note', 'Your response lost the race and was not used.'));
    }
    return line;
}

/**
 * Redraw the header from a newer row, in place (spec §9.3).
 *
 * The status pill, the responder and the closed line all live in the header,
 * and all three change the moment somebody else replies. Rebuilding just this
 * block is what lets the pane tell the truth about a settled message without
 * re-rendering the body underneath it — which is where the reader's half-typed
 * reply is.
 */
export function replaceHeader(root, detail, kicker) {
    const existing = root.querySelector('.detail-header');
    if (!existing) return;
    root.replaceChild(detailHeader(detail, kicker), existing);
}

/**
 * A banner between the header and the body — the "Answered elsewhere" of spec
 * §9.3 and the orphan mark of §16.5.
 *
 * Keyed by `kind` and replaced in place, so a message that settles while you
 * watch gets one banner rather than one per repaint. Built here rather than in
 * each renderer so all three say it the same way; *what* it says is decided in
 * `reply.js`, where it can be asserted without a DOM.
 */
export function showNotice(root, notice) {
    if (!notice) return null;

    let bar = root.querySelector(`.detail-banner[data-banner="${notice.kind}"]`);
    if (!bar) {
        bar = el('aside', `detail-banner detail-banner--${notice.kind}`);
        bar.dataset.banner = notice.kind;
        bar.setAttribute('role', 'status');
        root.querySelector('.detail-header')?.after(bar);
    }

    bar.textContent = '';
    bar.appendChild(el('strong', 'detail-banner-title', notice.title));
    bar.appendChild(el('span', 'detail-banner-detail', notice.detail));
    return bar;
}

/** Take a banner back down — an orphan that has since been settled, say. */
export function removeNotice(root, kind) {
    root.querySelector(`.detail-banner[data-banner="${kind}"]`)?.remove();
}

/**
 * The agent's `context` — why you are being asked — in a collapsible block.
 *
 * Collapsed by default in pane 3 for the same reason it is in dialog.js: the
 * question is what needs answering and the context is what explains it, and a
 * long context otherwise pushes the options off the screen.
 */
export function contextBlock(text) {
    if (!text) return null;

    const section = el('section', 'detail-context');
    const toggle = el('button', 'detail-context-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.appendChild(el('span', 'arrow', '▶'));
    toggle.appendChild(el('span', 'detail-context-label', 'Why the agent is asking'));

    const body = el('div', 'detail-context-body md-content');
    body.hidden = true;
    renderMarkdownInto(body, text);

    toggle.addEventListener('click', () => {
        body.hidden = !body.hidden;
        toggle.setAttribute('aria-expanded', String(!body.hidden));
        toggle.querySelector('.arrow')?.classList.toggle('open', !body.hidden);
    });

    section.appendChild(toggle);
    section.appendChild(body);
    return section;
}

/**
 * A footer action.
 *
 * `handler` of `null` means this pane was given no handler for the action —
 * a harness, or a caller that built the detail pane without `actions`. The
 * control is still rendered, because hiding it would misrepresent what the
 * message affords, but it is disabled and says why rather than silently doing
 * nothing when clicked.
 */
export function actionButton(label, className, handler) {
    const button = el('button', `button ${className}`, label);
    button.type = 'button';
    if (handler) {
        button.addEventListener('click', handler);
    } else {
        button.disabled = true;
        button.dataset.unattached = 'true';
        button.title = 'This pane has no reply handler attached.';
    }
    return button;
}

/** Whether anyone still has to act on this message. */
export function isOpen(row) {
    return row.status === 'pending' || row.status === 'stale';
}
