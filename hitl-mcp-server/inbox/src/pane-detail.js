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

    function empty() {
        panel(container, 'detail-empty', 'Nothing selected', 'Pick a message to see it here.');
    }

    async function show(message) {
        const token = ++generation;

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
            renderNotification(container, detail, actions);
            return;
        }
        if (detail.row.msgType !== 'plan_review') {
            renderQuestion(container, detail, actions);
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

        renderReview(container, detail, body, actions);
    }

    function clear() {
        generation += 1;
        empty();
    }

    empty();
    return { show, clear };
}
