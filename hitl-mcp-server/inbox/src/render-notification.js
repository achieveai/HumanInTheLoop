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
    renderMarkdownInto(body, request?.body ?? '');
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

    function drawFooter() {
        bar.textContent = '';
        if (!settled) {
            bar.appendChild(actionButton('Dismiss', 'button-primary',
                actions.onDismiss ? dismiss : null));
            return;
        }
        bar.appendChild(el('p', 'detail-retained', RETAINED));
        if (currentRow.responseId) {
            const button = actionButton('Mark unread', 'button-secondary',
                actions.onRestore ? restore : null);
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
        try {
            await actions.onDismiss(row);
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
        replaceHeader(root, { ...detail, row: nextRow }, KICKER);
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

    return { applyRow };
}
