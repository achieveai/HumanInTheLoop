// Pane 2 — the message list (spec §7).
//
// A list only: headers, no body, no controls. Every row shows the same fixed
// set of fields regardless of message type (spec §7.1), which is the whole
// point — it is the uniform projection over three dissimilar message families.
//
// Built with DOM calls rather than template strings. Message titles, context
// snippets and responder names are agent-authored text, and `textContent`
// cannot be talked into interpreting any of it as markup.

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The pinned filters of spec §7.3, in the order they are shown. */
export const FILTERS = [
    { key: 'all', label: 'All', count: list => list.counts.all },
    { key: 'needs_you', label: 'Needs you', count: list => list.counts.needsYou },
    { key: 'answered', label: 'Answered', count: list => list.counts.answered },
    { key: 'notifications', label: 'Notifications', count: list => list.counts.notifications },
];

/**
 * A relative age, short enough to sit in a row without wrapping.
 *
 * Deliberately coarse: the exact time is on the `title` attribute, and a row
 * that re-renders "1m 4s" every second is a row that never sits still.
 */
export function formatAge(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '';
    if (seconds < MINUTE) return 'now';
    if (seconds < HOUR) return `${Math.floor(seconds / MINUTE)}m`;
    if (seconds < DAY) return `${Math.floor(seconds / HOUR)}h`;
    return `${Math.floor(seconds / DAY)}d`;
}

/** Absolute time for the hover title, per spec §7.1. */
export function formatAbsolute(unixSeconds) {
    if (!unixSeconds) return '';
    return new Date(unixSeconds * 1000).toLocaleString();
}

/** `changes_requested` reads as `changes requested` on the pill sub-label. */
function humanise(token) {
    return String(token).replace(/_/g, ' ');
}

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
}

/**
 * The filter bar (spec §7.3).
 *
 * Counts come from the server over the whole scope, before the filter is
 * applied, so each tab can say what it holds rather than what the current one
 * does.
 */
export function renderFilterBar(container, list, { onFilter } = {}) {
    container.textContent = '';

    for (const filter of FILTERS) {
        const active = list.filter === filter.key;
        const button = el('button', 'filter', filter.label);
        button.dataset.filter = filter.key;
        button.setAttribute('role', 'tab');
        button.setAttribute('aria-selected', String(active));
        if (active) button.classList.add('is-active');
        if (list.defaultFilter === filter.key) button.dataset.default = 'true';

        button.appendChild(el('span', 'filter-count', String(filter.count(list) ?? 0)));
        button.addEventListener('click', () => onFilter?.(filter.key));
        container.appendChild(button);
    }
}

/** The status pill, with the verdict as a sub-label on answered plan reviews. */
function statusPill(message) {
    const pill = el('span', `status-pill status-pill--${message.status}`);
    pill.appendChild(el('span', 'status-pill-label', humanise(message.status)));
    if (message.verdict) {
        pill.appendChild(el('span', 'status-pill-verdict', humanise(message.verdict)));
    }
    return pill;
}

/**
 * The badge row (spec §7.1).
 *
 * `plaintext` is a tri-state on the wire: `null` means the log does not record
 * whether the envelope was encrypted, and an unknown is not a warning. Only an
 * explicit `true` raises the badge.
 */
function badges(message) {
    const row = el('div', 'message-badges');
    const { repo, batchCount, revision, attachment, plaintext } = message.badges ?? {};

    if (repo) row.appendChild(el('span', 'badge badge-repo', repo));
    if (batchCount) row.appendChild(el('span', 'badge badge-batch', `${batchCount}×`));
    if (revision) row.appendChild(el('span', 'badge badge-revision', `r${revision}`));
    if (attachment) row.appendChild(el('span', 'badge badge-attachment', 'attachment'));
    if (plaintext === true) row.appendChild(el('span', 'badge badge-plaintext', 'plaintext'));

    return row;
}

function messageRow(message, { selectedId, onSelect } = {}) {
    const row = el('div', 'message-row');
    row.dataset.messageId = message.messageId;
    row.dataset.status = message.status;
    row.dataset.type = message.msgType;
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    if (message.messageId === selectedId) row.classList.add('is-selected');

    const glyph = el('span', 'message-glyph', message.glyph);
    glyph.title = message.msgType;
    row.appendChild(glyph);

    const main = el('div', 'message-main');

    const headline = el('div', 'message-headline');
    headline.appendChild(el('span', 'message-title', message.title));
    headline.appendChild(statusPill(message));
    const age = el('span', 'message-age', formatAge(message.ageSeconds));
    age.title = formatAbsolute(message.createdAt);
    headline.appendChild(age);
    main.appendChild(headline);

    const meta = el('div', 'message-meta');
    if (message.responder) {
        const responder = el('span', 'message-responder', message.responder);
        if (message.respondedAt) responder.title = formatAbsolute(message.respondedAt);
        meta.appendChild(responder);
    }
    if (message.contextSnippet) {
        meta.appendChild(el('span', 'message-context', message.contextSnippet));
    }
    if (meta.childElementCount > 0) main.appendChild(meta);

    const badgeRow = badges(message);
    if (badgeRow.childElementCount > 0) main.appendChild(badgeRow);

    row.appendChild(main);

    const select = () => onSelect?.(message);
    row.addEventListener('click', select);
    row.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            select();
        }
    });

    return row;
}

/** Render the list. Server-ordered newest first; nothing is re-sorted here. */
export function renderMessageList(container, list, options = {}) {
    container.textContent = '';

    if (!list.messages.length) {
        container.appendChild(el('p', 'list-empty', emptyText(list)));
        return;
    }

    for (const message of list.messages) {
        container.appendChild(messageRow(message, options));
    }
}

function emptyText(list) {
    if (list.counts?.all === 0) return 'No messages yet.';
    const filter = FILTERS.find(f => f.key === list.filter);
    return `Nothing under ${filter ? filter.label : list.filter}.`;
}
