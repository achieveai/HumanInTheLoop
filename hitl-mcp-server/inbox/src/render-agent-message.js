// Pane 3 — messages you send to an agent.
//
// Three pieces. `renderAgentMessage` shows one you already sent: its text, and
// whether the agent has replied (a Notify naming it in `inReplyTo`). The
// compose box sits under the footer of any message whose session can take
// messages, addressed to that session; `listComposer` puts the same box under
// the list when an agent is picked in the tree. The server side delivers it on
// the agent's next hook or channel push.

import { detailHeader, el } from './detail-shell.js';

const KICKER = 'Message to agent';

/** Who a message goes to, in the words the agent tree uses. */
function sessionName(row) {
    if (!row.sessionLabel) return 'this session';
    // Outside a repo the label is the whole name and is its own project.
    return row.sessionLabel === row.projectKey ? row.sessionLabel : `${row.projectKey} · ${row.sessionLabel}`;
}

export function renderAgentMessage(container, detail) {
    const { row, request } = detail;

    container.textContent = '';
    const root = el('article', 'detail-root detail-agent-message');
    root.dataset.messageId = row.messageId;
    root.dataset.status = row.status;
    root.appendChild(detailHeader(detail, KICKER));

    const scroll = el('div', 'detail-scroll');
    scroll.appendChild(el('p', 'agent-message-to', `To ${sessionName(row)}`));
    scroll.appendChild(el('div', 'agent-message-text', request?.text ?? ''));
    scroll.appendChild(el('p', 'detail-retained', row.status === 'replied'
        ? 'The agent replied. Its reply is a notification in this session.'
        : 'Waiting for the agent to read it. It arrives on the agent’s next step, or wakes it when idle.'));
    root.appendChild(scroll);
    container.appendChild(root);
    return null;
}

/**
 * The compose box for `row`'s session, or `null` when it cannot take messages:
 * no session tag (an older HITL server) or no send handler.
 */
export function composeBox(row, onMessageAgent) {
    if (!row?.sessionTag || !onMessageAgent) return null;
    return buildCompose(row, onMessageAgent);
}

const PICK_HINT = 'Pick an agent to message it.';
const NO_TAG = 'Restart this agent to message it (its HITL is older).';

/**
 * The box under the list for the agent picked in the tree (`session` is its
 * `SessionRow`), or a hint when no single agent is picked. Never hidden: an
 * agent that cannot take messages yet gets a disabled box that says why.
 */
export function listComposer(session, onMessageAgent) {
    if (!session) return el('p', 'list-compose-hint', PICK_HINT);
    const target = {
        sessionTag: session.sessionTag,
        sessionLabel: session.label,
        projectKey: session.projectKey,
        messageId: 'list',
    };
    return buildCompose(target, session.sessionTag ? onMessageAgent : null, NO_TAG);
}

/** The form itself; with no `onMessageAgent` it is disabled and says `reason`. */
function buildCompose(row, onMessageAgent, reason) {
    const form = el('form', 'detail-compose');
    form.setAttribute('aria-label', `Message ${sessionName(row)}`);
    form.appendChild(el('label', 'detail-compose-to', `To: ${sessionName(row)}`));

    const text = el('textarea', 'detail-compose-text');
    text.rows = 2;
    text.placeholder = 'Message the agent…';
    text.setAttribute('aria-label', 'Message text');
    form.querySelector('label').htmlFor = text.id = `compose-${row.messageId}`;
    form.appendChild(text);

    const send = el('button', 'button button-primary', 'Send');
    send.type = 'submit';
    send.disabled = true;
    const status = el('p', 'detail-compose-status');
    status.setAttribute('role', 'status');

    const bar = el('div', 'detail-compose-bar');
    bar.append(status, send);
    form.appendChild(bar);

    if (!onMessageAgent) {
        text.disabled = true;
        status.textContent = reason;
        return form;
    }

    text.addEventListener('input', () => {
        send.disabled = !text.value.trim();
    });
    // Ctrl+Enter sends, like the "Other" field in a question.
    text.addEventListener('keydown', event => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) form.requestSubmit();
    });

    form.addEventListener('submit', async event => {
        event.preventDefault();
        const message = text.value.trim();
        if (!message || send.disabled) return;
        send.disabled = true;
        text.disabled = true;
        status.className = 'detail-compose-status';
        status.textContent = 'Sending…';
        try {
            await onMessageAgent(row, message);
            text.value = '';
            status.textContent = 'Sent. It is under All in this agent’s list.';
        } catch (err) {
            status.className = 'detail-compose-status detail-compose-status--error';
            status.textContent = `Not sent. ${err?.message ?? err}`;
            send.disabled = false;
        } finally {
            text.disabled = false;
        }
    });

    return form;
}
