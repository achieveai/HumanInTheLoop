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
    renderMarkdownInto,
} from './detail-shell.js';

export function renderNotification(container, detail, actions = {}) {
    const { row, request } = detail;

    container.textContent = '';
    const root = el('article', 'detail-root detail-notification');
    root.dataset.messageId = row.messageId;
    root.dataset.status = row.status;

    root.appendChild(detailHeader(detail, 'Notification'));

    const scroll = el('div', 'detail-scroll');

    const body = el('div', 'notification-body md-content');
    renderMarkdownInto(body, request?.body ?? '');
    scroll.appendChild(body);

    const context = contextBlock(request?.context);
    if (context) scroll.appendChild(context);

    root.appendChild(scroll);
    root.appendChild(footer(row, actions));
    container.appendChild(root);
}

function footer(row, actions) {
    const bar = el('footer', 'detail-actions');

    if (isOpen(row)) {
        bar.appendChild(actionButton('Dismiss', 'button-primary', actions.onDismiss
            ? () => actions.onDismiss(row)
            : null));
        return bar;
    }

    // Already dismissed. The button is gone rather than disabled — there is
    // nothing left to do — and the note says plainly that the message is kept,
    // because a row that survives its own Dismiss otherwise reads as a bug.
    bar.appendChild(el(
        'p',
        'detail-retained',
        'Dismissed everywhere. This message is kept in the Inbox so the agent’s history stays readable.',
    ));
    return bar;
}
