// Pane 2 — the message list (spec §7).
//
// A list only: headers, no body, no controls. Every row shows the same fixed
// set of fields regardless of message type (spec §7.1), which is the whole
// point — it is the uniform projection over three dissimilar message families.
//
// Built with DOM calls rather than template strings. Message titles, context
// snippets and responder names are agent-authored text, and `textContent`
// cannot be talked into interpreting any of it as markup.

import { participantChip } from './detail-shell.js';
import { participantsOf } from './participants.js';

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const scrollRestoreTokens = new WeakMap();
// Reused DOM rows must dispatch the latest projection and selection callback.
const rowSelections = new WeakMap();
const virtualLists = new WeakMap();
const VIRTUAL_THRESHOLD = 200;
const OVERSCAN = 8;

/** The pinned filters of spec §7.3, in the order they are shown. */
export const FILTERS = [
    { key: 'all', label: 'All', count: list => list.counts.all },
    { key: 'needs_you', label: 'Needs you', count: list => list.counts.needsYou },
    { key: 'answered', label: 'Answered', count: list => list.counts.answered },
];

export const TYPES = [
    { key: 'work', label: 'Work' },
    { key: 'notification', label: 'Notifications' },
    { key: 'question', label: 'Questions' },
    { key: 'plan_review', label: 'Review plans' },
    { key: 'handoff', label: 'Handoffs' },
    { key: 'agent_message', label: 'Sent' },
];

const TYPE_ICONS = {
    work: '<rect x="3" y="4" width="10" height="9" rx="1"/><path d="M6 4V2.5h4V4M3 7.5h10"/>',
    notification: '<path d="M4 11h8l-1-1.5V7a3 3 0 0 0-6 0v2.5zM7 13h2"/>',
    question: '<path d="M5.5 5.5a2.5 2.5 0 1 1 4 2c-1 .7-1.5 1.1-1.5 2.5M8 12.5h.01"/>',
    plan_review: '<path d="M4 2h6l2 2v10H4zM6 7h4M6 10h4"/>',
    handoff: '<path d="M2.5 5h10m-3-3 3 3-3 3M13.5 11h-10m3-3-3 3 3 3"/>',
    agent_message: '<path d="M14 2 7 9M14 2l-4 12-3-5-5-3z"/>',
};

/** Work shares notification transport but has its own display family. */
export const messageType = message => message.work ? 'work' : message.msgType;

/** Explicit lifecycle and task counts, separate from the read/dismissal pill. */
export function appendWorkBadges(container, work) {
    if (!work) return;
    const label = { pending: 'Pending', in_progress: 'In progress', blocked: 'Blocked', completed: 'Completed', cancelled: 'Cancelled' }[work.status] ?? work.status;
    container.appendChild(el('span', 'badge badge-work-status', `Work: ${label}`));
    container.appendChild(el('span', 'badge badge-work-tasks', `${work.completedTasks}/${work.totalTasks} tasks completed`));
    if (work.blockedTasks) container.appendChild(el('span', 'badge badge-work-blocked', `${work.blockedTasks} blocked`));
    if (work.owner) container.appendChild(el('span', 'badge badge-work-owner', work.owner));
}

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

export function renderTypeFilterBar(container, messages, enabled, { onToggle } = {}) {
    for (const type of TYPES) {
        const pressed = enabled.has(type.key);
        let button = container.querySelector(`.type-filter[data-type="${type.key}"]`);
        if (!button) {
            button = el('button', 'type-filter');
            button.dataset.type = type.key;
            const icon = el('span', 'type-filter-icon');
            icon.setAttribute('aria-hidden', 'true');
            icon.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">${TYPE_ICONS[type.key]}</svg>`;
            button.append(icon, el('span', 'type-filter-label', type.label), el('span', 'filter-count'));
            button.setAttribute('aria-label', type.label);
            button.querySelector('.filter-count').id = `type-filter-count-${type.key}`;
            button.setAttribute('aria-describedby', `type-filter-count-${type.key}`);
            button.title = type.label;
            button.addEventListener('click', () => onToggle?.(type.key));
            container.appendChild(button);
        }
        button.setAttribute('aria-pressed', String(pressed));
        button.disabled = pressed && enabled.size === 1;
        const count = messages.filter(message => messageType(message) === type.key).length;
        button.querySelector('.filter-count').textContent = String(count);
        // A zero-count chip filters to nothing; hide it unless it is the
        // only kind still filtering, so the bar lists kinds that exist.
        button.hidden = count === 0 && !(pressed && enabled.size === 1);
    }
}

export function filterMessagesByType(messages, enabled) {
    return messages.filter(message => enabled.has(messageType(message)));
}

/**
 * The status pill, with the verdict as a sub-label on answered plan reviews.
 *
 * Exported so pane 3's header draws the identical pill from the identical row.
 * Two implementations of one vocabulary is two places for it to drift.
 */
export function statusPill(message) {
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
    appendWorkBadges(row, message.work);
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
    rowSelections.set(row, { message, onSelect });
    row.dataset.messageId = message.messageId;
    row.dataset.status = message.status;
    row.dataset.type = messageType(message);
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    if (message.messageId === selectedId) row.classList.add('is-selected');

    const glyph = el('span', 'message-glyph', message.glyph);
    glyph.title = messageType(message);
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
    if (message.sessionName) {
        const session = el('span', 'message-session', message.sessionName);
        if (message.objective) session.title = message.objective;
        meta.appendChild(session);
    }
    if (message.machine) {
        const machine = el('span', 'message-machine', `on ${message.machine}`);
        machine.title = `The agent runs on ${message.machine}`;
        meta.appendChild(machine);
    }
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

    const select = () => {
        const current = rowSelections.get(row);
        current.onSelect?.(current.message);
    };
    row.addEventListener('click', select);
    row.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            select();
        }
    });

    return row;
}

/**
 * What makes one conversation. Sub-agents of one task each send from their
 * own session, but the reader thinks in tasks: every session sharing a
 * title + objective is ONE conversation (a lead plus its judge-k/judge-j
 * spawns, say). Rows without that signature fall back to one conversation
 * per session; `unattributed` rows group by project and session name.
 */
export function conversationKeyOf(message) {
    const title = (message.sessionName ?? '').trim();
    const objective = (message.objective ?? '').trim();
    if (title && objective) return `task:${title} ${objective}`;
    if (message.sessionKey) return `${message.sessionKey} ${message.projectKey ?? ''}`;
    return `unattributed ${message.projectKey ?? ''} ${message.sessionName ?? message.sessionLabel ?? ''}`;
}

/** Whether anyone still has to act on this message. */
export function isOpenMessage(message) {
    return message.status === 'pending' || message.status === 'stale';
}

/**
 * Group a newest-first message list into conversations, newest activity first.
 *
 * Pure projection over the rows the server already sent — pane 2 never
 * re-asks for the list it was just handed. `rows` stays newest-first; the
 * thread re-sorts when it draws.
 */
export function groupConversations(messages) {
    const byKey = new Map();
    for (const message of messages) {
        const key = conversationKeyOf(message);
        let conversation = byKey.get(key);
        if (!conversation) {
            conversation = { key, rows: [] };
            byKey.set(key, conversation);
        }
        conversation.rows.push(message);
    }
    const conversations = [];
    for (const conversation of byKey.values()) {
        const { rows } = conversation;
        const latest = rows.reduce((a, b) => ((b.createdAt ?? 0) > (a.createdAt ?? 0) ? b : a));
        conversation.latest = latest;
        // The anchor is what opening the conversation selects and scrolls
        // to: the OLDEST thing still waiting for you — the thread reads
        // oldest → newest, so it must open at the top of the unread run,
        // not wherever a newest-first scope list happens to put a match.
        const open = rows
            .filter(isOpenMessage)
            .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
        conversation.anchor = open[0] ?? latest;
        conversation.openCount = rows.filter(isOpenMessage).length;
        conversation.sessionKey = latest.sessionKey ?? null;
        conversation.sessionName = latest.sessionName ?? null;
        conversation.sessionLabel = latest.sessionLabel ?? null;
        conversation.projectKey = latest.projectKey ?? null;
        conversation.machine = latest.machine ?? null;
        conversation.objective = latest.objective ?? null;
        // Merged task: the sessions behind it and who spoke from each. The
        // thread fetches every member session; chips name each sub-agent.
        const members = new Map();
        for (const row of rows) {
            if (!row.sessionKey) continue;
            if (!members.has(row.sessionKey)) {
                members.set(row.sessionKey, {
                    sessionKey: row.sessionKey,
                    sessionLabel: row.sessionLabel ?? row.sessionKey,
                });
            }
        }
        conversation.memberSessions = [...members.values()];
        conversation.participants = participantsOf(rows);
        conversation.merged = conversation.participants.length > 1;
        const machines = new Set(rows.map(row => row.machine).filter(Boolean));
        conversation.machines = [...machines];
        conversations.push(conversation);
    }
    conversations.sort((a, b) => ((b.latest.createdAt ?? 0) - (a.latest.createdAt ?? 0))
        || String(a.latest.messageId).localeCompare(String(b.latest.messageId)));
    return conversations;
}

/**
 * One icon per message kind a conversation holds, action-first order. The
 * handoff's recording glyph is a "✓", which in a list reads as "done" — the
 * exchange mark is the one the thread settled on.
 */
function conversationKinds(rows) {
    const order = ['question', 'plan_review', 'handoff', 'work', 'notification', 'agent_message'];
    const byKind = new Map();
    for (const row of rows) {
        const kind = messageType(row);
        if (!byKind.has(kind)) byKind.set(kind, row.glyph ?? '');
    }
    return [...byKind.entries()]
        .map(([kind, glyph]) => ({ kind, label: kind.replace(/_/g, ' '), glyph: glyph === '✓' ? '⇄' : glyph }))
        .sort((a, b) => {
            const ai = order.indexOf(a.kind);
            const bi = order.indexOf(b.kind);
            return (ai === -1 ? order.length : ai) - (bi === -1 ? order.length : bi);
        });
}

/**
 * One row per conversation (OWA-style), riding the same .message-row chrome
 * as the flat list so virtualization and selection keep working.
 */
function conversationRow(conversation, { selectedId, selectedConversationKey, onSelect } = {}) {
    const { latest, anchor } = conversation;
    const unread = conversation.openCount > 0;
    const row = el('div', 'message-row conversation-row');
    row.dataset.messageId = anchor.messageId;
    row.dataset.conversationKey = conversation.key;
    row.dataset.status = latest.status;
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    if (conversation.key === selectedConversationKey || anchor.messageId === selectedId) {
        row.classList.add('is-selected');
    }
    if (unread) row.classList.add('conversation-row--unread');

    // Line 1 names the agent and shows one icon per message kind present;
    // line 2 carries the newest subject with its status and date.

    const main = el('div', 'message-main');

    const headline = el('div', 'message-headline');
    const name = el('span', 'conversation-name',
        conversation.sessionName || conversation.sessionLabel || 'Unattributed');
    if (conversation.objective) name.title = conversation.objective;
    headline.appendChild(name);
    const kinds = conversationKinds(conversation.rows);
    if (kinds.length) {
        const icons = el('span', 'conversation-kinds');
        for (const { label, glyph } of kinds) {
            const icon = el('span', 'conversation-kind', glyph || '•');
            icon.title = label;
            icons.appendChild(icon);
        }
        headline.appendChild(icons);
    }
    if (conversation.openCount > 0) {
        headline.appendChild(el('span', 'conversation-count', String(conversation.openCount)));
    }
    main.appendChild(headline);

    const subject = el('div', 'conversation-subject');
    subject.appendChild(el('span', 'conversation-subject-text', latest.title));
    subject.appendChild(statusPill(latest));
    const age = el('span', 'message-age', formatAge(latest.ageSeconds));
    age.title = formatAbsolute(latest.createdAt);
    subject.appendChild(age);
    main.appendChild(subject);

    // Merged task: one chip per sub-agent so the row says who is speaking
    // inside the conversation without opening it.
    if (conversation.merged) {
        const roster = el('div', 'conversation-participants');
        const MAX_CHIPS = 6;
        for (const participant of conversation.participants.slice(0, MAX_CHIPS)) {
            roster.appendChild(participantChip(participant));
        }
        const extra = conversation.participants.length - MAX_CHIPS;
        if (extra > 0) {
            const more = el('span', 'participant-more', `+${extra}`);
            more.title = conversation.participants.slice(MAX_CHIPS)
                .map(participant => participant.name).join(', ');
            roster.appendChild(more);
        }
        main.appendChild(roster);
    }

    const metaBits = [];
    if (!conversation.merged) {
        if (conversation.sessionName && conversation.sessionLabel) metaBits.push(conversation.sessionLabel);
        if (conversation.machine) metaBits.push(`on ${conversation.machine}`);
        if (conversation.projectKey) metaBits.push(conversation.projectKey);
    } else if (conversation.machines.length === 1) {
        metaBits.push(`on ${conversation.machines[0]}`);
    }
    if (metaBits.length) main.appendChild(el('div', 'message-meta', metaBits.join(' · ')));
    row.appendChild(main);

    const select = () => onSelect?.(conversation);
    row.addEventListener('click', select);
    row.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            select();
        }
    });

    return row;
}

/**
 * The OWA-style list: one row per conversation, newest activity first.
 * Conversation rows are anchor pseudo-rows, so the row-generic
 * virtualization in `renderMessageList` carries them unchanged.
 */
export function renderConversationList(container, list, conversations, options = {}) {
    const pseudoMessages = conversations.map(conversation => ({
        ...conversation.anchor,
        __conversation: conversation,
    }));
    const buildRow = (message, rowOptions) => conversationRow(message.__conversation, rowOptions);
    return renderMessageList(container, { ...list, messages: pseudoMessages }, options, buildRow);
}

function visibleSelectedAnchor(container, anyVisible = false) {
    const containerRect = container.getBoundingClientRect();
    const selected = anyVisible ? Array.from(container.querySelectorAll('.message-row')).find(row => {
        const rect = row.getBoundingClientRect();
        return rect.bottom > containerRect.top && rect.top < containerRect.bottom;
    }) : container.querySelector('.message-row.is-selected');
    if (!selected) return null;
    const rowRect = selected.getBoundingClientRect();
    if (rowRect.bottom <= containerRect.top || rowRect.top >= containerRect.bottom) return null;
    return {
        messageId: selected.dataset.messageId,
        top: rowRect.top - containerRect.top,
    };
}

/**
 * Whether the reader is at the top: the first message at least partly in view.
 * New messages then show instead of the list holding what is on screen still.
 */
function firstRowVisible(container) {
    const first = container.querySelector('.message-row');
    if (!first) return true;
    return first.getBoundingClientRect().bottom > container.getBoundingClientRect().top;
}

function firstRowId(container) {
    return container.querySelector('.message-row')?.dataset.messageId;
}

function restoreSelectedAnchor(container, anchor) {
    const selected = Array.from(container.querySelectorAll('.message-row'))
        .find(row => row.dataset.messageId === anchor.messageId);
    if (!selected || selected.dataset.messageId !== anchor.messageId) return;
    const currentTop = selected.getBoundingClientRect().top - container.getBoundingClientRect().top;
    const delta = currentTop - anchor.top;
    if (Number.isFinite(delta) && Math.abs(delta) > 0.5) container.scrollTop += delta;
}

function restoreSelectedAnchorAfterLayout(container, anchor, restoreToken, expectedScrollTop, frames) {
    requestAnimationFrame(() => {
        const currentToken = scrollRestoreTokens.get(container);
        if (!container.isConnected
            || currentToken !== restoreToken
            || Math.abs(container.scrollTop - expectedScrollTop) > 0.5) {
            if (currentToken === restoreToken) scrollRestoreTokens.delete(container);
            return;
        }
        restoreSelectedAnchor(container, anchor);
        if (frames > 1) {
            restoreSelectedAnchorAfterLayout(
                container, anchor, restoreToken, container.scrollTop, frames - 1,
            );
        } else {
            scrollRestoreTokens.delete(container);
        }
    });
}

function reconcileMessageNodes(container, candidates) {
    const activeElement = container.ownerDocument.activeElement;
    const focusedId = container.contains(activeElement)
        ? activeElement.closest('.message-row')?.dataset.messageId : null;
    // Replacing a large list makes WebView2 announce every removed and added
    // accessibility object to Windows. Keep unchanged rows connected instead.
    const existing = new Map(Array.from(container.children, row => [row.dataset.messageId, row]));
    const desired = candidates.map(candidate => {
        const previous = existing.get(candidate.dataset.messageId);
        if (previous && previous.isEqualNode(candidate)) {
            if (rowSelections.has(candidate)) {
                rowSelections.set(previous, rowSelections.get(candidate));
            }
            return previous;
        }
        return candidate;
    });
    const retained = new Set(desired);
    for (const row of Array.from(container.children)) {
        if (!retained.has(row)) row.remove();
    }
    let cursor = container.firstChild;
    for (const row of desired) {
        if (row === cursor) cursor = cursor.nextSibling;
        else container.insertBefore(row, cursor);
    }
    if (focusedId) {
        const focusedRow = desired.find(row => row.dataset.messageId === focusedId);
        if (focusedRow && container.ownerDocument.activeElement !== focusedRow) {
            focusedRow.focus({ preventScroll: true });
        }
    }
}

function heightKind(message) {
    const b = message.badges ?? {};
    const hasBadges = message.work || b.repo || b.batchCount || b.revision || b.attachment || b.plaintext;
    return `${Boolean(message.contextSnippet || message.responder || message.sessionName || message.machine)}:${Boolean(hasBadges)}`;
}

function measureOffsets(state) {
    state.offsets = [0];
    for (const message of state.messages) {
        const height = state.heights.get(message.messageId) ?? state.estimates.get(heightKind(message)) ?? 60;
        state.offsets.push(state.offsets.at(-1) + height);
    }
}

function indexAt(state, top) {
    let low = 0, high = state.messages.length - 1;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (state.offsets[middle + 1] <= top) low = middle + 1;
        else high = middle;
    }
    return low;
}

function virtualAnchor(state) {
    if (!state.messages.length || state.container.scrollTop <= 0) return null;
    const index = indexAt(state, state.container.scrollTop);
    return { id: state.messages[index].messageId, within: state.container.scrollTop - state.offsets[index] };
}

function atVirtualEnd(state) {
    return state.container.scrollTop > 0
        && state.container.scrollTop >= state.offsets.at(-1) - state.container.clientHeight - 2;
}

function paintVirtual(state, anchor = virtualAnchor(state), stickToEnd = atVirtualEnd(state)) {
    const { container } = state;
    const viewport = container.clientHeight || 600;
    // Two bounded passes learn actual variable row heights without mounting
    // the history. The same message stays under the reader as estimates settle.
    for (let pass = 0; pass < 2; pass++) {
        const anchorIndex = anchor ? state.indices.get(anchor.id) : undefined;
        const top = Math.max(0, stickToEnd ? state.offsets.at(-1) - viewport
            : anchorIndex === undefined ? 0 : state.offsets[anchorIndex] + anchor.within);
        const first = Math.max(0, indexAt(state, top) - OVERSCAN);
        const end = Math.min(state.messages.length, indexAt(state, top + viewport) + 1 + OVERSCAN);
        const indices = new Set(Array.from({ length: end - first }, (_, i) => first + i));
        const active = container.ownerDocument.activeElement;
        const focusedId = state.focusTarget ?? (container.contains(active) ? active.closest('.message-row')?.dataset.messageId : null);
        const focusedIndex = state.indices.get(focusedId);
        if (focusedIndex !== undefined) indices.add(focusedIndex);

        const spacer = el('div', 'message-list-spacer');
        spacer.setAttribute('aria-hidden', 'true');
        spacer.style.height = `${state.offsets.at(-1)}px`;
        const nodes = [spacer];
        for (const index of [...indices].sort((a, b) => a - b)) {
            const row = (state.options.buildRow ?? messageRow)(state.messages[index], state.options);
            row.classList.add('message-row--virtual');
            row.style.top = `${state.offsets[index]}px`;
            row.setAttribute('aria-description', `Message ${index + 1} of ${state.messages.length}`);
            nodes.push(row);
        }
        reconcileMessageNodes(container, nodes);
        container.scrollTop = top;

        let changed = false;
        for (const row of container.querySelectorAll('.message-row')) {
            const height = row.getBoundingClientRect().height;
            if (height <= 0) continue;
            const message = state.messages[state.indices.get(row.dataset.messageId)];
            const kind = heightKind(message);
            if (!state.estimates.has(kind) || state.staleKinds?.delete(kind)) { state.estimates.set(kind, height); changed = true; }
            if (state.heights.get(message.messageId) !== height) {
                state.heights.set(message.messageId, height);
                changed = true;
            }
        }
        if (!changed) break;
        measureOffsets(state);
        container.firstElementChild.style.height = `${state.offsets.at(-1)}px`;
        for (const row of container.querySelectorAll('.message-row')) {
            row.style.top = `${state.offsets[state.indices.get(row.dataset.messageId)]}px`;
        }
        container.scrollTop = Math.max(0, stickToEnd ? state.offsets.at(-1) - viewport
            : anchorIndex === undefined ? 0 : state.offsets[anchorIndex] + anchor.within);
    }
}

function focusVirtual(state, index) {
    const { container } = state;
    const id = state.messages[index].messageId;
    state.focusTarget = id;
    const top = state.offsets[index], bottom = state.offsets[index + 1];
    if (top < container.scrollTop) container.scrollTop = top;
    else if (bottom > container.scrollTop + container.clientHeight) container.scrollTop = bottom - container.clientHeight;
    paintVirtual(state);
    const row = Array.from(container.children).find(row => row.dataset.messageId === id);
    row?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: 'nearest' });
    state.focusTarget = null;
}

function renderVirtualList(container, list, options) {
    let state = virtualLists.get(container);
    const entering = !state;
    // At the top, new messages show (see `firstRowVisible`). A virtual list
    // mounts rows out of order, so its top comes from the offsets instead.
    const atTop = entering ? firstRowVisible(container)
        : !state.messages.length || container.scrollTop < state.offsets[1];
    const previousFirst = entering ? firstRowId(container) : state.messages[0]?.messageId;
    const newOnTop = atTop && list.messages[0]?.messageId !== previousFirst;
    const previousAnchor = entering && !newOnTop && container.scrollTop > 0 ? visibleSelectedAnchor(container, true) : null;
    if (!state) {
        state = { container, messages: [], options: {}, offsets: [0], indices: new Map(),
            heights: new Map(), estimates: new Map(), width: container.clientWidth, frame: 0 };
        state.schedule = () => {
            if (state.frame) return;
            state.frame = requestAnimationFrame(() => {
                state.frame = 0;
                if (virtualLists.get(container) !== state || !container.isConnected) return;
                // A resize has already changed the geometry by now, so "at the
                // end" comes from the last scroll or paint, not from this frame.
                const anchor = virtualAnchor(state), end = state.atEnd ?? atVirtualEnd(state);
                if (container.clientWidth && state.width !== container.clientWidth) {
                    state.width = container.clientWidth;
                    // Old estimates stay until each kind is measured again: the
                    // rows on screen are too few to stand in for the rest.
                    state.heights.clear(); state.staleKinds = new Set(state.estimates.keys()); measureOffsets(state);
                }
                paintVirtual(state, anchor, end);
                state.atEnd = atVirtualEnd(state);
            });
        };
        state.scroll = () => {
            state.atEnd = atVirtualEnd(state);
            state.schedule();
        };
        state.keydown = event => {
            if (event.altKey || event.ctrlKey || event.metaKey) return;
            const row = event.target.closest('.message-row');
            const index = state.indices.get(row?.dataset.messageId);
            if (index === undefined) return;
            const page = Math.max(1, Math.floor(container.clientHeight / 60));
            const target = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0,
                End: state.messages.length - 1, PageDown: index + page, PageUp: index - page,
                Tab: index + (event.shiftKey ? -1 : 1) }[event.key];
            if (target === undefined || (event.key === 'Tab' && (target < 0 || target >= state.messages.length))) return;
            event.preventDefault();
            focusVirtual(state, Math.max(0, Math.min(state.messages.length - 1, target)));
        };
        virtualLists.set(container, state);
        container.dataset.virtual = 'true';
        container.addEventListener('scroll', state.scroll, { passive: true });
        container.addEventListener('keydown', state.keydown);
        state.resize = new ResizeObserver(state.schedule);
        state.resize.observe(container);
    }
    const sameScope = state.scopeKey === list.scopeKey && state.filter === list.filter;
    const anchor = newOnTop ? null
        : previousAnchor ? { id: previousAnchor.messageId, within: -previousAnchor.top }
        : sameScope ? virtualAnchor(state) : null;
    const end = !newOnTop && !entering && sameScope && atVirtualEnd(state);
    const selectionChanged = !entering && state.options.selectedId !== options.selectedId;
    state.messages = list.messages; state.options = options;
    state.scopeKey = list.scopeKey; state.filter = list.filter;
    state.indices = new Map(list.messages.map((message, index) => [message.messageId, index]));
    for (const id of state.heights.keys()) if (!state.indices.has(id)) state.heights.delete(id);
    measureOffsets(state);
    paintVirtual(state, anchor, end);
    state.atEnd = atVirtualEnd(state);
    if (selectionChanged && state.indices.has(options.selectedId)) {
        const index = state.indices.get(options.selectedId);
        // Selection may change from a dismissal or keyboard action. Reveal it
        // without stealing focus from the reading pane or an action button.
        if (state.offsets[index + 1] <= container.scrollTop || state.offsets[index] >= container.scrollTop + container.clientHeight) {
            container.scrollTop = state.offsets[index];
            paintVirtual(state);
        }
    }
}

/** Render the list. Server-ordered newest first; nothing is re-sorted here.
 * `buildRow` overrides the row shape (the conversation list uses it); the
 * default is the flat per-message row. */
export function renderMessageList(container, list, options = {}, buildRow = messageRow) {
    if (list.messages.length > VIRTUAL_THRESHOLD) {
        renderVirtualList(container, list, { ...options, buildRow });
        return;
    }
    const virtual = virtualLists.get(container);
    const atTop = virtual ? container.scrollTop < virtual.offsets[1] : firstRowVisible(container);
    const previousFirst = virtual ? virtual.messages[0]?.messageId : firstRowId(container);
    const newOnTop = atTop && list.messages[0]?.messageId !== previousFirst;
    const anchor = newOnTop ? null : visibleSelectedAnchor(container, Boolean(virtual));
    if (virtual) {
        cancelAnimationFrame(virtual.frame);
        virtual.resize.disconnect();
        container.removeEventListener('scroll', virtual.scroll);
        container.removeEventListener('keydown', virtual.keydown);
        virtualLists.delete(container);
        delete container.dataset.virtual;
    }
    const restoreToken = {};
    scrollRestoreTokens.set(container, restoreToken);
    const nodes = list.messages.length ? list.messages.map(message => buildRow(message, options))
        : [el('p', 'list-empty', options.emptyText ?? emptyText(list))];
    reconcileMessageNodes(container, nodes);
    if (newOnTop) container.scrollTop = 0;
    if (!anchor) return;

    restoreSelectedAnchor(container, anchor);
    restoreSelectedAnchorAfterLayout(container, anchor, restoreToken, container.scrollTop, 2);
}

function emptyText(list) {
    if (list.counts?.all === 0) return 'No messages yet.';
    const filter = FILTERS.find(f => f.key === list.filter);
    return `Nothing under ${filter ? filter.label : list.filter}.`;
}
