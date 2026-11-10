import { renderWorkDocument } from './work-document.js';
// Pane 3 — the notification renderer (spec §8.1).
//
// The simplest of the three, and read-mostly: a title, a markdown body, the
// agent's context if it gave one, who sent it, and a Dismiss button.
//
// # The one deliberate divergence from the popup
//
// Dismissing here **retains** the message with status `dismissed`. The existing
// notification popup discards a card entirely and auto-closes 1.5 s after its
// list empties, so a notification you glanced at and dismissed is gone with no
// record that it ever arrived. That is fine for a popup and wrong for an inbox:
// "what did that agent tell me an hour ago" is a question the popup structurally
// cannot answer, and it is most of why this pane is worth building.
//
// Nothing here stores `dismissed`. The status is folded from a
// `dismiss_notification` event in the log, exactly as every other status is
// (spec §4.2) — which is also why dismissing on the phone shows up here.

import {
    actionButton,
    contextBlock,
    detailHeader,
    el,
    iconActionButton,
    isOpen,
    removeNotice,
    renderMarkdownInto,
    replaceHeader,
    showNotice,
} from './detail-shell.js';
import { raceNotice } from './reply.js';

const KICKER = 'Notification';
const RETAINED =
    'Dismissed everywhere. This message is kept in the Inbox so the agent’s history stays readable.';

export function renderNotification(container, detail, actions = {}) {
    const { row, request } = detail;

    container.textContent = '';
    const root = el('article', 'detail-root detail-notification');
    root.dataset.messageId = row.messageId;
    root.dataset.status = row.status;

    root.appendChild(detailHeader(detail, KICKER));

    const scroll = el('div', 'detail-scroll');

    const body = el('div', 'notification-body md-content');
    if (request?.type === 'work_update') renderWorkDocument(body, request.document, undefined, request.body);
    else renderMarkdownInto(body, request?.body ?? '');
    scroll.appendChild(body);

    const context = contextBlock(request?.context);
    if (context) scroll.appendChild(context);

    const error = el('p', 'detail-error');
    error.hidden = true;
    error.setAttribute('role', 'alert');
    scroll.appendChild(error);

    root.appendChild(scroll);

    const bar = el('footer', 'detail-actions');
    root.appendChild(bar);
    container.appendChild(root);

    let currentRow = row;
    let settled = !isOpen(row);
    let restoreInFlight = false;
    drawFooter();

    function readAction(unread, handler) {
        const button = iconActionButton('ack', 'notification-read-action', handler,
            unread ? 'Mark as unread' : 'Mark as read');
        const svg = button.querySelector('svg');
        svg.setAttribute('width', '14');
        svg.setAttribute('height', '14');
        svg.innerHTML = unread
            ? '<rect x="1.5" y="3" width="13" height="10" rx="1.5"/><path d="m2 4 6 4.5L14 4"/>'
            : '<path d="M1.5 6 8 1.5 14.5 6v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V6Z"/><path d="m1.5 6 6.5 4 6.5-4M2 13l4-3M14 13l-4-3"/>';
        return button;
    }

    function drawFooter() {
        bar.textContent = '';
        if (!settled) {
            // An envelope makes the read-state action recognizable.
            bar.appendChild(readAction(false, actions.onDismiss ? dismiss : null));
            return;
        }
        bar.appendChild(el('p', 'detail-retained', RETAINED));
        if (currentRow.responseId) {
            const button = readAction(true, actions.onRestore ? restore : null);
            button.disabled ||= restoreInFlight;
            bar.appendChild(button);
        }
    }

    /**
     * A dismissal is published like any other reply and races like one: two
     * devices can dismiss the same notification, and the fold names whichever
     * was first in ntfy order. It matters much less here than it does for a
     * question — both devices asked for the same outcome and both got it — so
     * the button simply locks and the header reports who the log credits.
     */
    async function dismiss() {
        if (settled) return;
        const button = bar.querySelector('.button');
        if (button) button.disabled = true;
        error.hidden = true;
        const dismissedRevision = currentRow.work ? currentRow.badges?.revision : null;
        try {
            const responseId = await actions.onDismiss(currentRow);
            if (responseId && (!dismissedRevision || currentRow.badges?.revision === dismissedRevision) && (isOpen(currentRow)
                || (currentRow.status === 'dismissed' && !currentRow.responseId))) {
                applyRow({ ...currentRow, status: 'dismissed', responseId });
            }
        } catch (err) {
            if (button) button.disabled = false;
            error.textContent = `Could not dismiss this — nothing left this machine. ${err?.message ?? err}`;
            error.hidden = false;
        }
    }

    async function restore() {
        if (!settled || restoreInFlight || !currentRow.responseId) return;
        restoreInFlight = true;
        error.hidden = true;
        drawFooter();
        try {
            await actions.onRestore(currentRow);
            applyRow({ ...currentRow, status: 'pending', responseId: null,
                responder: null, respondedAt: null });
        } catch (err) {
            restoreInFlight = false;
            drawFooter();
            error.textContent = `Could not mark this unread — nothing left this machine. ${err?.message ?? err}`;
            error.hidden = false;
        }
    }

    /** The folded status moved while this pane was open (spec §9.3). */
    function applyRow(nextRow) {
        currentRow = nextRow;
        root.dataset.status = nextRow.status;
        const fold = root.querySelector(':scope > .detail-header[data-type="notification"] .thread-card-fold');
        replaceHeader(root, { ...detail, row: nextRow }, KICKER);
        if (fold) root.querySelector(':scope > .detail-header > .detail-headline')?.appendChild(fold);
        settled = !isOpen(nextRow);
        restoreInFlight = false;
        error.hidden = true;
        removeNotice(root, 'orphan');
        removeNotice(root, 'answered-elsewhere');
        removeNotice(root, 'closed-elsewhere');
        drawFooter();
        if (settled) {
            showNotice(root, raceNotice(nextRow, actions.myResponseId?.(nextRow.messageId) ?? null));
        }
    }

    function applyDetail(next) {
        if (next.request?.type !== 'work_update') return;
        renderWorkDocument(body, next.request.document, undefined, next.request.body);
        applyRow(next.row);
    }

    return { applyRow, applyDetail };
}
