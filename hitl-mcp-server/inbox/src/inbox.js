// The Inbox shell: fetch both panes, draw them, and redraw when the log moves.
//
// There is no client-side model. Selection is the only state kept here; every
// number, status and grouping on screen came from `list_sessions()` /
// `list_messages()`, which derive them from the event log. That is the §4.2
// rule carried all the way to the DOM — nothing here can drift from what the
// events say, because nothing here remembers anything.

import { renderAgentTree } from './pane-agents.js';
import { renderFilterBar, renderMessageList } from './pane-list.js';

/** Emitted by the Rust side when a genuinely new event lands. */
const CHANGED_EVENT = 'inbox-changed';

export function createInbox({ invoke, elements, onError = console.error }) {
    const { agents, filterBar, messageList, detail } = elements;

    const state = {
        /** A `scopeKey` handed out by `list_sessions()`. Never composed here. */
        scopeKey: 'all',
        /**
         * `null` means "let the server pick" — which resolves to `Needs you`
         * when anything in scope is pending (spec §7.3). Adopted once the first
         * list comes back, so a later answer cannot move the highlighted tab
         * out from under the user, and reset to `null` whenever the scope
         * changes so each agent gets its own default.
         */
        filter: null,
        selectedId: null,
    };

    async function refresh() {
        const tree = await invoke('list_sessions');
        renderAgentTree(agents, tree, {
            selectedScope: state.scopeKey,
            onSelect: selectScope,
        });

        const list = await invoke('list_messages', {
            sessionKey: state.scopeKey,
            filter: state.filter,
        });
        if (state.filter === null) state.filter = list.filter;

        renderFilterBar(filterBar, list, { onFilter: selectFilter });
        renderMessageList(messageList, list, {
            selectedId: state.selectedId,
            onSelect: selectMessage,
        });
    }

    function run(promise) {
        return promise.catch(onError);
    }

    function selectScope(scopeKey) {
        state.scopeKey = scopeKey;
        // A different agent is a different question about what needs you, so
        // its filter is re-defaulted rather than inherited.
        state.filter = null;
        return run(refresh());
    }

    function selectFilter(filter) {
        state.filter = filter;
        return run(refresh());
    }

    function selectMessage(message) {
        state.selectedId = message.messageId;
        for (const row of messageList.querySelectorAll('.message-row')) {
            row.classList.toggle('is-selected', row.dataset.messageId === message.messageId);
        }
        showDetailPlaceholder(message);
    }

    /**
     * Pane 3 is its own task — three renderers, one per message type. Until
     * they land this pane says which message is selected and admits it cannot
     * yet show it, rather than rendering a half-message that looks complete.
     */
    function showDetailPlaceholder(message) {
        detail.textContent = '';
        const wrap = document.createElement('div');
        wrap.className = 'detail-placeholder';
        wrap.dataset.messageId = message.messageId;
        wrap.dataset.type = message.msgType;

        const title = document.createElement('h2');
        title.className = 'detail-title';
        title.textContent = message.title;
        wrap.appendChild(title);

        const note = document.createElement('p');
        note.className = 'detail-note';
        note.textContent = 'The renderer for this message type is not built yet.';
        wrap.appendChild(note);

        detail.appendChild(wrap);
    }

    return { refresh, selectScope, selectFilter, selectMessage, state };
}

async function main() {
    const tauri = window.__TAURI__;
    if (!tauri) return;

    const inbox = createInbox({
        invoke: tauri.core.invoke,
        elements: {
            agents: document.getElementById('pane-agents'),
            filterBar: document.getElementById('filter-bar'),
            messageList: document.getElementById('message-list'),
            detail: document.getElementById('pane-detail'),
        },
    });

    await inbox.refresh();

    // The view is a function of the log, so there is nothing finer-grained to
    // listen for: one event lands, both panes are re-derived.
    await tauri.event.listen(CHANGED_EVENT, () => {
        inbox.refresh().catch(console.error);
    });
}

main().catch(console.error);
