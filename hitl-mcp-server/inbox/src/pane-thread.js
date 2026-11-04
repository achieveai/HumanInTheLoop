// Pane 3 — the conversation thread (OWA-style reading pane).
//
// One selection opens the whole exchange with an agent, oldest → newest:
// every message the session ever sent, in the order it arrived. Messages that
// still need you render as full cards through the same per-type renderers the
// single-message pane used; everything settled collapses to a one-line summary
// that expands on click. The reply box sits at the bottom of the thread,
// addressed to the conversation's session.
//
// The full exchange is one ask below the list: `list_messages` for the
// session's own scope, unfiltered. The current list may be status- or
// type-filtered, and the collapsed history has to come from the log.
//
// This pane keeps the createDetailPane API — show/update/rename/clear plus
// the park/restore/discard trio the optimistic reply flow drives — so inbox.js
// holds no second contract. Where the single pane parked its whole DOM on an
// optimistic action, the thread keeps cards mounted: a dismissed card settles
// into its collapsed line in place, and a rollback simply expands it again.

import { el, sessionLine, badgeIcon, participantChip } from './detail-shell.js';
import { participantsOf, participantOf } from './participants.js';
import {
    conversationKeyOf,
    formatAbsolute,
    formatAge,
    isOpenMessage,
    messageType,
    statusPill,
} from './pane-list.js';
import { renderNotification } from './render-notification.js';
import { renderQuestion } from './render-question.js';
import { renderHandoff } from './render-handoff.js';
import { renderReview } from './render-review.js';
import { renderAgentMessage, threadComposer } from './render-agent-message.js';
import { orphanNotice } from './reply.js';
import { iconSvg } from './icons.js';

export function createThreadPane({ container, invoke, onError = console.error, actions = {} }) {
    // Bumped by every show/clear. Responses with a stale token are dropped.
    let generation = 0;

    /** What is on screen: `{ key, anchorId, rows, latestId, sessionBacked }`. */
    let painted = null;

    /** Message ids the reader expanded by hand, kept across refreshes. */
    const expanded = new Set();
    /** Open-message ids the reader folded away; an explicit choice a refresh must not reopen. */
    const collapsed = new Set();
    /** Editor drafts captured when a card collapses, replayed if it reopens. */
    const recovered = new Map();
    /** Live cards by messageId: `{ node, controller, row }`. */
    const cards = new Map();

    let refreshInFlight = false;

    function latestOf(rows) {
        return rows.reduce((best, row) => ((row.createdAt ?? 0) > (best?.createdAt ?? -1) ? row : best), null);
    }

    /**
     * Per-kind glyphs come from the recording; a handoff arrives as "✓",
     * which in a thread reads as "done". Swap it for an exchange mark — the
     * kind name stays on the title tooltip either way.
     */
    function threadGlyph(row) {
        const glyph = el('span', 'message-glyph', row.glyph ?? '');
        glyph.title = messageType(row);
        if (glyph.textContent.trim() === '✓') glyph.textContent = '⇄';
        return glyph;
    }

    /**
     * Cards identify the message; the thread header identifies the session.
     * Where a card repeats the header — same title, same machine chip — the
     * copy hides instead of saying the same thing twice.
     */
    function dedupeCard(article) {
        const threadTitle = container.querySelector('.thread-header .detail-title')
            ?.textContent.trim();
        const title = article.querySelector('.detail-title');
        if (title && threadTitle && title.textContent.trim() === threadTitle) {
            title.classList.add('is-dup');
        }
        article.querySelector('.detail-meta .badge-machine')?.remove();
    }

    function disposeCard(messageId) {
        const card = cards.get(messageId);
        if (!card) return;
        try {
            card.controller?.dispose?.();
        } catch (error) {
            onError?.(error);
        }
        cards.delete(messageId);
    }

    function captureDraft(messageId, card) {
        try {
            if (typeof card.controller?.captureRecovery === 'function') {
                recovered.set(messageId, card.controller.captureRecovery());
            }
        } catch (error) {
            onError?.(error);
        }
    }

    function empty() {
        for (const messageId of [...cards.keys()]) disposeCard(messageId);
        painted = null;
        container.textContent = '';
        const wrap = el('div', 'detail-panel detail-empty');
        wrap.appendChild(el('h2', 'detail-panel-title', 'Nothing selected'));
        wrap.appendChild(el('p', 'detail-panel-note', 'Pick a conversation to see it here.'));
        container.appendChild(wrap);
    }

    /**
     * The conversation-level orphan mark (spec §16.5), as a header icon with
     * the full explanation in a hover (or focus) popover — the warning is
     * about the session, so one mark per conversation says it. `null` while
     * no message in the thread marks the session silent.
     */
    function orphanMark(rows) {
        const notice = rows.map(orphanNotice).find(Boolean);
        if (!notice) return null;
        const icon = el('span', 'thread-orphan');
        icon.tabIndex = 0;
        icon.dataset.tip = `${notice.title} — ${notice.detail}`;
        icon.setAttribute('role', 'img');
        icon.setAttribute('aria-label', `${notice.title}. ${notice.detail}`);
        icon.innerHTML = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" '
            + 'stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" '
            + 'focusable="false"><path d="M8 2.4 14.4 13.2H1.6L8 2.4Z"/><path d="M8 6.4v2.8"/>'
            + '<path d="M8 11.6v.01"/></svg>';
        return icon;
    }

    /** (Re)place the orphan icon after a fresh paint or a reconcile. */
    function paintOrphanMark(rows) {
        const headline = container.querySelector('.thread-header .detail-headline');
        if (!headline) return;
        headline.querySelector('.thread-orphan')?.remove();
        const mark = orphanMark(rows);
        if (mark) headline.appendChild(mark);
    }

    function threadHeader(anchor, rows) {
        const header = el('header', 'thread-header detail-header');
        header.appendChild(el('div', 'detail-kicker', 'Conversation'));

        const title = el('div', 'detail-headline');
        title.appendChild(el('h2', 'detail-title', anchor.sessionName || anchor.sessionLabel || 'Unattributed'));
        const openCount = rows.filter(isOpenMessage).length;
        if (openCount > 0) {
            title.appendChild(el('span', 'conversation-count',
                `${openCount} need${openCount === 1 ? 's' : ''} you`));
        }
        header.appendChild(title);

        const meta = el('div', 'detail-meta');
        if (anchor.machine) {
            const machine = el('span', 'badge badge-machine');
            machine.appendChild(badgeIcon('machine'));
            machine.appendChild(document.createTextNode(anchor.machine));
            machine.title = `The agent runs on ${anchor.machine}`;
            meta.appendChild(machine);
        }
        if (anchor.projectKey) {
            const project = el('span', 'badge');
            project.appendChild(badgeIcon('folder'));
            project.appendChild(document.createTextNode(anchor.projectKey));
            meta.appendChild(project);
        }
        const latest = latestOf(rows);
        if (latest) {
            meta.appendChild(el('span', 'detail-when', `Last activity ${formatAbsolute(latest.createdAt)}`));
        }
        header.appendChild(meta);

        // Merged task: name every sub-agent once, above the exchange.
        if (mergedThread) {
            const roster = el('div', 'thread-participants');
            for (const participant of participantsOf(rows)) {
                roster.appendChild(participantChip(participant));
            }
            header.appendChild(roster);
        }

        // The name is the title two lines up; only the objective and earlier
        // names earn a line here.
        const session = sessionLine(anchor, { name: false });
        if (session) header.appendChild(session);
        return header;
    }

    /** Merged task: a slim bar naming the sub-agent at the card's top edge. */
    function tagCardParticipant(article, row) {
        if (!mergedThread) return;
        const who = el('div', 'thread-card-participant');
        who.appendChild(participantChip(participantOf(row)));
        article.insertBefore(who, article.firstChild);
    }

    /** The compact header a card gets when the recording has no body for it. */
    function cardFallbackHeader(row) {
        const header = el('header', 'thread-card-header');
        const top = el('div', 'message-headline');
        top.appendChild(threadGlyph(row));
        top.appendChild(el('span', 'message-title', row.title));
        top.appendChild(statusPill(row));
        const age = el('span', 'message-age', formatAge(row.ageSeconds));
        age.title = formatAbsolute(row.createdAt);
        top.appendChild(age);
        header.appendChild(top);
        return header;
    }

    /** The one-line collapsed form of a settled message. */
    function collapsedLine(row) {
        const line = el('button', 'thread-line');
        line.type = 'button';
        line.dataset.messageId = row.messageId;
        line.setAttribute('aria-expanded', 'false');

        line.appendChild(threadGlyph(row));

        const main = el('span', 'thread-line-main');
        const top = el('span', 'thread-line-top');
        top.appendChild(el('span', 'thread-line-title', row.title));
        top.appendChild(statusPill(row));
        const age = el('span', 'message-age', formatAge(row.ageSeconds));
        age.title = formatAbsolute(row.createdAt);
        top.appendChild(age);
        main.appendChild(top);

        const sub = el('span', 'thread-line-sub');
        if (mergedThread) sub.appendChild(participantChip(participantOf(row)));
        // The kind word wears the expanded card's kicker treatment (see
        // .thread-line-kind), so the one-line form and the open card read as
        // the same header in two states.
        const kind = el('span', 'thread-line-kind', row.work ? 'Work' : messageType(row));
        sub.appendChild(kind);
        if (row.responder) sub.appendChild(el('span', '', ` · ${row.responder}`));
        main.appendChild(sub);
        line.appendChild(main);

        line.addEventListener('click', () => toggleRow(row.messageId));
        return line;
    }

    /**
     * A message paints as a full card unless the reader folded it away.
     * Unacted messages default open; settled ones default to their one-line
     * form — either way the reader's explicit choice wins, and a refresh or
     * a new arrival can't reopen what was folded.
     */
    function cardIsOpen(row) {
        return !collapsed.has(row.messageId) && (isOpenMessage(row) || expanded.has(row.messageId));
    }

    function toggleRow(messageId) {
        const state = painted;
        const row = state?.rows.find(candidate => candidate.messageId === messageId);
        if (!state || !row) return;
        if (cardIsOpen(row)) {
            if (isOpenMessage(row)) collapsed.add(messageId);
            else expanded.delete(messageId);
            collapseCard(messageId);
        } else {
            collapsed.delete(messageId);
            expanded.add(messageId);
            const node = state.nodes?.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
            if (node) expandRow(row, node);
        }
    }

    function expandRow(row, node) {
        const slot = el('div', 'thread-card-slot');
        slot.dataset.messageId = row.messageId;
        node.replaceWith(slot);
        mountCard(slot, row, generation);
    }

    /** Settle a live card back into its collapsed one-line form. */
    function collapseCard(messageId) {
        const card = cards.get(messageId);
        const state = painted;
        const row = state?.rows.find(candidate => candidate.messageId === messageId);
        if (!card || !state || !row) return;
        captureDraft(messageId, card);
        disposeCard(messageId);
        card.node.replaceWith(collapsedLine(row));
    }

    /**
     * Draw one full card. The shell lands immediately; the detail (and the
     * plan body, for reviews) fills in behind a generation token so a slow
     * fetch can never paint over a newer selection.
     */
    async function mountCard(slot, row, token) {
        const article = el('article', 'thread-card');
        article.dataset.messageId = row.messageId;
        article.dataset.status = row.status;
        slot.replaceChildren(article);

        // Every message folds both ways: the same control collapses a card
        // back to its one-line form (drafts are captured, not lost). It must
        // be appended LAST — every renderer opens by clearing the article
        // (`container.textContent = ''`), so anything added here earlier
        // would not survive the render.
        const fold = el('button', 'thread-card-fold');
        fold.type = 'button';
        fold.title = 'Collapse to one line';
        fold.setAttribute('aria-label', 'Collapse message to one line');
        fold.innerHTML = iconSvg('chevronDown', 14);
        fold.addEventListener('click', () => toggleRow(row.messageId));

        let detail = null;
        try {
            detail = await invoke('get_message', { messageId: row.messageId });
        } catch (error) {
            if (token === generation) onError?.(error);
        }
        if (token !== generation) return;
        if (!painted || !painted.rows.some(candidate => candidate.messageId === row.messageId)) return;

        if (!detail) {
            // The harness recording only carries details for messages that
            // needed someone; the live app answers every id. The row alone
            // still identifies the message.
            article.appendChild(cardFallbackHeader(row));
            tagCardParticipant(article, row);
            article.appendChild(el('p', 'thread-card-missing',
                'No body in this recording — the live app loads it here.'));
            article.appendChild(fold);
            cards.set(row.messageId, { node: article, controller: null, row });
            return;
        }

        let controller = null;
        try {
            if (detail.row.msgType === 'agent_message') {
                renderAgentMessage(article, detail);
            } else if (detail.row.msgType === 'notification') {
                controller = renderNotification(article, detail, actions);
            } else if (detail.row.msgType === 'handoff') {
                controller = renderHandoff(article, detail, actions);
            } else if (detail.row.msgType !== 'plan_review') {
                controller = renderQuestion(article, detail, actions);
            } else {
                let body = null;
                try {
                    body = await invoke('get_body', { messageId: row.messageId });
                } catch (error) {
                    if (token === generation) onError?.(error);
                    body = { outcome: 'commandFailed', detail: String(error?.message ?? error) };
                }
                if (token !== generation) return;
                let draft = null;
                if (body?.outcome === 'ok' && actions.onLoadDraft) {
                    try {
                        draft = await actions.onLoadDraft({
                            planId: detail.request?.planId || '',
                            reviewId: detail.row.messageId,
                            snapshotHash: detail.request?.snapshotHash || '',
                        });
                    } catch (error) {
                        if (token === generation) onError?.(error);
                    }
                    if (token !== generation) return;
                }
                controller = renderReview(article, detail, body, actions, draft);
            }
        } catch (error) {
            if (token === generation) {
                onError?.(error);
                article.appendChild(el('p', 'thread-card-missing', 'This message could not be drawn.'));
            }
        }
        if (token !== generation) return;

        // The thread header owns the orphan mark; a renderer's per-card
        // banner (it doubles for standalone mounts) must not leak into it.
        article.querySelector('.detail-banner--orphan')?.remove();
        dedupeCard(article);
        tagCardParticipant(article, row);
        // Keep the review's keyboard-accessible fold in its existing header.
        const reviewHeader = article.querySelector(':scope > article.detail-review > header.detail-header');
        if (reviewHeader) reviewHeader.prepend(fold);
        else article.appendChild(fold);
        // The header is a collapse target too: clicking anywhere on it folds
        // the card to its one line — the same toggle the corner button
        // drives. Controls inside the header (links, buttons, fields) keep
        // their own jobs and never reach the toggle.
        article.addEventListener('click', (event) => {
            if (!event.target.closest('header.detail-header')) return;
            if (event.target.closest('a, button, input, textarea, select, [contenteditable]')) return;
            toggleRow(row.messageId);
        });
        cards.set(row.messageId, { node: article, controller, row });
        const recovery = recovered.get(row.messageId);
        if (recovery !== undefined && typeof controller?.restoreRecovery === 'function') {
            try {
                controller.restoreRecovery(recovery);
            } catch (error) {
                onError?.(error);
            }
        }
        recovered.delete(row.messageId);
    }

    /**
     * Set by paint() to the opening batch's mount promises: the anchor
     * scroll waits for all of them before measuring. Null outside paint —
     * reconcile and manual expands drop the promise as before.
     */
    let openingMounts = null;

    /** True while the painted thread merges several sub-agent sessions. */
    let mergedThread = false;

    function nodeForRow(row, token) {
        if (cardIsOpen(row)) {
            const slot = el('div', 'thread-card-slot');
            slot.dataset.messageId = row.messageId;
            const mounted = mountCard(slot, row, token);
            if (openingMounts) openingMounts.push(mounted);
            if (window.__MOUNT_TRACE) {
                const rec = { id: row.messageId, done: false };
                window.__MOUNT_TRACE.push(rec);
                Promise.resolve(mounted).then(() => { rec.done = true; }, () => { rec.done = true; rec.failed = true; });
            }
            return slot;
        }
        return collapsedLine(row);
    }

    async function onThreadMessage(row, text) {
        const id = await actions.onMessageAgent(row, text);
        // The sent message folds into this conversation on the next refresh;
        // nudge it so the reader sees their own message without waiting.
        refreshThread();
        return id;
    }

    async function show(message, conversation = null) {
        const key = conversationKeyOf(message);
        if (painted?.key === key) return update(message);
        const token = ++generation;
        for (const messageId of [...cards.keys()]) disposeCard(messageId);
        painted = null;
        container.textContent = '';
        const loading = el('div', 'detail-panel detail-loading');
        loading.appendChild(el('h2', 'detail-panel-title', message.title));
        loading.appendChild(el('p', 'detail-panel-note', 'Loading conversation…'));
        container.appendChild(loading);

        // The whole exchange lives one scope below the list: the session
        // itself, unfiltered. Rows the current list already has would do for
        // the open few, but the collapsed history has to come from the log.
        let rows = [message];
        let sessionBacked = false;
        const fetchSession = async (sessionKey) => {
            const list = await invoke('list_messages', {
                sessionKey: `session:${sessionKey}`,
                filter: 'all',
            });
            return list?.messages ?? [];
        };
        // Merged task: the other sub-agents' sessions complete the
        // conversation — one fetch per member, deduped by id below.
        const memberKeys = (conversation?.memberSessions ?? [])
            .map(member => member.sessionKey)
            .filter(key => key && key !== message.sessionKey);
        if (message.sessionKey) {
            try {
                const own = await fetchSession(message.sessionKey);
                if (own.length) {
                    rows = own;
                    sessionBacked = true;
                }
                for (const key of memberKeys) {
                    try {
                        const theirs = await fetchSession(key);
                        if (theirs.length) {
                            rows = rows.concat(theirs);
                            sessionBacked = true;
                        }
                    } catch (error) {
                        if (token === generation) onError?.(error);
                    }
                }
            } catch (error) {
                if (token === generation) onError?.(error);
            }
        }
        if (token !== generation) return;
        const seenIds = new Set();
        rows = rows.filter(row => {
            const id = row.messageId;
            if (seenIds.has(id)) return false;
            seenIds.add(id);
            return true;
        });
        paint(message, rows, sessionBacked, token, [message.sessionKey, ...memberKeys].filter(Boolean));
    }

    function paint(anchor, rows, sessionBacked, token, sessionKeys) {
        container.textContent = '';
        // Before any node is built (the header roster consults it).
        mergedThread = new Set(rows.map(row => row.sessionKey).filter(Boolean)).size > 1;
        const root = el('div', 'thread-root');
        root.dataset.conversationKey = conversationKeyOf(anchor);
        root.appendChild(threadHeader(anchor, rows));

        const scroll = el('div', 'thread-scroll');
        const ordered = [...rows].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
        openingMounts = [];
        for (const row of ordered) {
            scroll.appendChild(nodeForRow(row, token));
        }
        root.appendChild(scroll);

        if (actions.onMessageAgent) {
            const composeRow = rows.find(row => row.sessionTag) ?? anchor;
            const footer = el('footer', 'thread-compose');
            // Collapsed to one quiet row until the reader asks for it — the
            // box is not worth a slab of thread when most opens end in a read.
            const open = el('button', 'thread-compose-open', 'New message');
            open.type = 'button';
            open.addEventListener('click', () => {
                footer.classList.add('is-open');
                footer.querySelector('.detail-compose-text')?.focus();
                // The composer just grew under the last card; bring it into
                // view rather than leaving its top row cut at the fold.
                const scroll = root.querySelector('.thread-scroll');
                scroll?.scrollTo({ top: scroll.scrollHeight });
            });
            footer.appendChild(open);
            footer.appendChild(threadComposer({
                sessionTag: composeRow.sessionTag,
                sessionLabel: composeRow.sessionLabel,
                sessionName: composeRow.sessionName,
                projectKey: composeRow.projectKey,
                messageId: 'thread',
            }, onThreadMessage));
            root.appendChild(footer);
        }

        container.appendChild(root);
        paintOrphanMark(rows);
        painted = {
            key: conversationKeyOf(anchor),
            anchorId: anchor.messageId,
            rows,
            latestId: latestOf(rows)?.messageId,
            sessionBacked,
            sessionKeys: [...new Set(sessionKeys)],
            nodes: scroll,
        };

        // The first unacted message owns the reading pane: anchor it at the
        // top. Cards stream their details in async, and a scroll issued
        // before the thread reaches full height no-ops or lands short — so
        // wait for the opening batch to settle before measuring. Renderers
        // also focus their internals on mount (review keyboard nav, the
        // composer), which yanks the pane to them; a short guard re-asserts
        // the anchor until the reader takes the wheel themselves.
        const anchorToView = () => {
            scroll.querySelector(`[data-message-id="${CSS.escape(anchor.messageId)}"]`)
                ?.scrollIntoView({ block: 'start' });
        };
        const mounts = openingMounts ?? [];
        openingMounts = null;
        const settle = () => {
            anchorToView();
            const baseline = scroll.scrollTop;
            (window.__ANCHOR_TRACE ??= []).push('settle:' + baseline);
            let readerDrove = false;
            const markReader = () => { readerDrove = true; };
            window.addEventListener('wheel', markReader, { passive: true });
            window.addEventListener('touchmove', markReader, { passive: true });
            window.addEventListener('keydown', markReader);
            let polls = 0;
            const guard = setInterval(() => {
                polls += 1;
                if (readerDrove || polls > 30 || !painted || painted.nodes !== scroll) {
                    clearInterval(guard);
                    window.removeEventListener('wheel', markReader);
                    window.removeEventListener('touchmove', markReader);
                    window.removeEventListener('keydown', markReader);
                    return;
                }
                if (Math.abs(scroll.scrollTop - baseline) > 2) {
                    window.__ANCHOR_TRACE.push('restore:' + scroll.scrollTop + '->' + baseline + '@' + polls);
                    scroll.scrollTop = baseline;
                }
            }, 100);
        };
        if (mounts.length === 0) {
            settle();
        } else {
            const all = Promise.all(mounts.map(promise => Promise.resolve(promise).then(() => {}, () => {})));
            // A detail that never answers must not hold the anchor hostage.
            const timeout = new Promise(resolve => setTimeout(resolve, 1500));
            Promise.race([all, timeout]).then(settle);
        }
    }

    /** Refetch the session list and fold any movement into the open thread. */
    async function refreshThread() {
        const state = painted;
        if (!state?.sessionBacked || refreshInFlight) return;
        const token = generation;
        refreshInFlight = true;
        try {
            const lists = await Promise.all(state.sessionKeys.map(sessionKey =>
                invoke('list_messages', {
                    sessionKey: `session:${sessionKey}`,
                    filter: 'all',
                })));
            if (token !== generation || painted !== state) return;
            // Reconcile only a complete snapshot: a failed/missing member must
            // not make its still-mounted questions disappear from the thread.
            if (lists.some(list => !Array.isArray(list?.messages))) return;
            const rows = new Map();
            for (const list of lists) {
                for (const row of list.messages) rows.set(row.messageId, row);
            }
            reconcile([...rows.values()]);
        } catch (error) {
            if (token === generation && painted === state) onError?.(error);
        } finally {
            refreshInFlight = false;
        }
    }

    /**
     * Fold a fresher session list into the painted thread: drop what left,
     * append what arrived, settle cards whose status closed, and leave every
     * live card's DOM (and whatever is typed into it) untouched.
     */
    function reconcile(incoming) {
        const state = painted;
        if (!state) return;
        const token = generation;
        const ordered = [...incoming].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
        const previousRows = new Map(state.rows.map(row => [row.messageId, row]));
        // Collapse reads state.rows: install fresh statuses before replacing cards.
        state.rows = ordered;
        const known = new Set(ordered.map(row => row.messageId));
        const scroll = state.nodes;

        for (const node of Array.from(scroll.querySelectorAll('[data-message-id]'))) {
            if (!known.has(node.dataset.messageId)) {
                disposeCard(node.dataset.messageId);
                node.remove();
            }
        }

        for (const row of ordered) {
            const card = cards.get(row.messageId);
            if (card) {
                const settled = !isOpenMessage(row) && !expanded.has(row.messageId);
                if (settled) {
                    collapseCard(row.messageId);
                } else if (card.row.status !== row.status || card.row.title !== row.title) {
                    card.row = row;
                    card.node.dataset.status = row.status;
                    card.controller?.applyRow?.(row);
                    const pill = card.node.querySelector('.status-pill');
                    if (pill) pill.replaceWith(statusPill(row));
                    // applyRow can re-raise the renderer's orphan banner; in
                    // a thread the header icon owns that mark.
                    card.node.querySelector('.detail-banner--orphan')?.remove();
                }
                continue;
            }
            const existing = scroll.querySelector(`[data-message-id="${CSS.escape(row.messageId)}"]`);
            if (existing) {
                const previous = previousRows.get(row.messageId);
                if (existing.classList.contains('thread-line')
                    && (previous?.status !== row.status || previous?.title !== row.title)) {
                    existing.replaceWith(collapsedLine(row));
                }
                continue;
            }
            // New arrivals land at the end: the sort is oldest → newest.
            scroll.appendChild(nodeForRow(row, token));
        }

        state.rows = ordered;
        state.latestId = latestOf(ordered)?.messageId;
        paintOrphanMark(ordered);
    }

    /**
     * The selected message's row moved (spec §9.3). Patch its card straight
     * away for the snap, then reconcile the whole thread so arrivals and
     * settlements elsewhere in the conversation show up too.
     */
    async function update(message) {
        const state = painted;
        if (!state) return show(message);
        if (state.key !== conversationKeyOf(message)) return show(message);
        const card = cards.get(message.messageId);
        if (card && card.controller?.applyRow
            && (card.row.status !== message.status || card.row.title !== message.title)) {
            card.row = message;
            card.node.dataset.status = message.status;
            card.controller.applyRow(message);
            card.node.querySelector('.detail-banner--orphan')?.remove();
        }
        return refreshThread();
    }

    /** The agent renamed its session: patch the thread header in place. */
    function rename(message) {
        const state = painted;
        if (!state || state.key !== conversationKeyOf(message)) return;
        const header = container.querySelector('.thread-header');
        if (!header) return;
        const line = sessionLine(message, { name: false });
        const current = header.querySelector('.detail-session');
        if (current && line) current.replaceWith(line);
        else if (current) current.remove();
        else if (line) header.querySelector('.detail-meta')?.after(line);
    }

    function clear() {
        generation += 1;
        empty();
    }

    // The optimistic reply flow parks the pane before a projection update and
    // restores it on rollback. Thread cards never leave the DOM for a filter
    // move — the thread is unfiltered — so park/restore are no-ops and
    // rollback's restore simply finds its card still mounted.
    function park() {
        return true;
    }

    function restore() {
        return true;
    }

    /** Confirm-time disposal: settle a closed card, keep a live one mounted. */
    function discard(messageId, { recover = false } = {}) {
        const card = cards.get(messageId);
        if (!card) return true;
        const state = painted;
        const row = state?.rows.find(candidate => candidate.messageId === messageId);
        if (!row) {
            disposeCard(messageId);
            card.node.remove();
            return true;
        }
        if (isOpenMessage(row) || expanded.has(messageId)) return true;
        if (recover) captureDraft(messageId, card);
        disposeCard(messageId);
        card.node.replaceWith(collapsedLine(row));
        return true;
    }

    empty();
    return { show, update, rename, clear, park, restore, discard };
}
