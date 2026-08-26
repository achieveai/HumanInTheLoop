// Pane 3 — the shell that picks a renderer (spec §8).
//
// Selection comes in, one of three renderers goes out. Everything type-specific
// lives in `render-notification.js`, `render-question.js` and
// `render-review.js`; this file decides which, fetches what they need, and
// handles the two things that go wrong around them: the message is gone, or the
// body could not be loaded.
//
// # Bodies are fetched on selection, never on paint
//
// `list_messages` is pure and pane 2 renders straight from it (spec §11). If a
// body fetch sat on the paint path, pane 2 would render differently depending on
// whether a *separate process* — the archivist — happened to be running, and a
// list that changes shape based on another process's uptime is not a list you
// can trust. So the network is touched here, once, for the one message the user
// actually opened, and only when that message is a plan review. Notifications
// and questions carry their whole body in the request payload and never fetch.
//
// # Out-of-order responses
//
// Two awaits per selection and a user who can click faster than either. Each
// `show()` takes a generation token and drops its own result if the selection
// moved on, so a slow fetch for a message you have already navigated away from
// cannot paint over the one you are looking at.
//
// # A status change is not a reason to re-render
//
// `update()` exists so that somebody else answering the message you are typing
// into does not cost you what you typed (spec §9.3). The renderer that is
// already on screen is handed the new row and locks itself in place; the DOM
// underneath the header — options, checkboxes, "Additional Context", every
// inline review comment — is left exactly as the reader left it. Re-rendering
// would be one line shorter and would throw all of it away.

import { el } from './detail-shell.js';
import { renderNotification } from './render-notification.js';
import { renderQuestion } from './render-question.js';
import { renderReview } from './render-review.js';

function panel(container, className, title, note) {
    container.textContent = '';
    const wrap = el('div', `detail-panel ${className}`);
    wrap.appendChild(el('h2', 'detail-panel-title', title));
    wrap.appendChild(el('p', 'detail-panel-note', note));
    container.appendChild(wrap);
    return wrap;
}

export function createDetailPane({ container, invoke, onError = console.error, actions = {} }) {
    // Bumped by every `show()` and every `clear()`. A response whose token is
    // stale is discarded rather than rendered.
    let generation = 0;

    /** What is on screen: `{ messageId, status, controller }`, or `null`. */
    let painted = null;

    function empty() {
        painted = null;
        panel(container, 'detail-empty', 'Nothing selected', 'Pick a message to see it here.');
    }

    async function show(message) {
        const token = ++generation;
        painted = null;

        // Named immediately, from the row we already have. The alternative is a
        // pane that goes blank on every click and fills in a moment later.
        const loading = panel(container, 'detail-loading', message.title, 'Loading…');
        loading.dataset.messageId = message.messageId;

        let detail;
        try {
            detail = await invoke('get_message', { messageId: message.messageId });
        } catch (err) {
            if (token !== generation) return;
            onError?.(err);
            panel(container, 'detail-failed', 'Could not open this message',
                String(err?.message ?? err));
            return;
        }
        if (token !== generation) return;

        if (!detail) {
            // The row came from the same log this lookup reads, so this means
            // the log moved between the two calls — a compaction, or a store
            // reopened underneath us.
            panel(container, 'detail-failed', 'This message is no longer in the log',
                'It may have been compacted away. Refresh the list.');
            return;
        }

        if (detail.row.msgType === 'notification') {
            remember(detail.row, renderNotification(container, detail, actions));
            return;
        }
        if (detail.row.msgType !== 'plan_review') {
            remember(detail.row, renderQuestion(container, detail, actions));
            return;
        }

        let body;
        try {
            body = await invoke('get_body', { messageId: message.messageId });
        } catch (err) {
            // The command itself failed — not the archivist, not the bytes.
            // Reported as its own reason so it does not read as either.
            onError?.(err);
            body = { outcome: 'commandFailed', detail: String(err?.message ?? err) };
        }
        if (token !== generation) return;

        // Only worth asking for once there is a plan to anchor comments to.
        // A failure here is not a reason to refuse the review: the draft is a
        // convenience, and losing it is much less bad than not being able to
        // open the plan at all.
        let draft = null;
        if (body?.outcome === 'ok' && actions.onLoadDraft) {
            try {
                draft = await actions.onLoadDraft({
                    planId: detail.request?.planId || '',
                    reviewId: detail.row.messageId,
                    snapshotHash: detail.request?.snapshotHash || '',
                });
            } catch (err) {
                onError?.(err);
            }
            if (token !== generation) return;
        }

        remember(detail.row, renderReview(container, detail, body, actions, draft));
    }

    function remember(row, controller) {
        painted = { messageId: row.messageId, status: row.status, controller };
    }

    /**
     * The selected message's folded status moved (spec §9.3).
     *
     * Handed to the renderer that is already on screen, which locks itself and
     * says why. Falls back to a full `show()` only when there is nothing to
     * update — a different message, or a renderer with no `applyRow`, which is
     * the read-only review panel that has no form to lose.
     */
    async function update(message) {
        if (!painted || painted.messageId !== message.messageId) return show(message);
        if (painted.status === message.status) return;

        painted.status = message.status;
        if (!painted.controller?.applyRow) return show(message);

        painted.controller.applyRow(message);
    }

    function clear() {
        generation += 1;
        empty();
    }

    empty();
    return { show, update, clear };
}
