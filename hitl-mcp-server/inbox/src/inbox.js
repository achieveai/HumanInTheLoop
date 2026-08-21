// The Inbox shell: fetch both panes, draw them, and redraw when the log moves.
//
// There is no client-side model. Selection is the only state kept here; every
// number, status and grouping on screen came from `list_sessions()` /
// `list_messages()`, which derive them from the event log. That is the §4.2
// rule carried all the way to the DOM — nothing here can drift from what the
// events say, because nothing here remembers anything.

import { renderAgentTree } from './pane-agents.js';
import { createDetailPane } from './pane-detail.js';
import { renderFilterBar, renderMessageList } from './pane-list.js';
import { createReplyActions } from './reply.js';

/** Emitted by the Rust side when a genuinely new event lands. */
const CHANGED_EVENT = 'inbox-changed';

export function createInbox({ invoke, elements, onError = console.error, actions = {} }) {
    const { agents, filterBar, messageList, detail } = elements;

    const detailPane = createDetailPane({ container: detail, invoke, onError, actions });

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
        /** The folded status pane 3 was last drawn with. See `refresh()`. */
        selectedStatus: null,
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

        // Pane 3 is told only when the *selected* message's folded status
        // actually moved — someone answered it on another device, the agent
        // exited. Reacting to every event instead would throw away scroll
        // position and half-typed review comments each time an unrelated
        // message arrived, which is a worse failure than a stale pane.
        //
        // `update` rather than `show`: the pane locks itself in place and keeps
        // everything the reader has typed (spec §9.3).
        const selected = list.messages.find(m => m.messageId === state.selectedId);
        if (selected && selected.status !== state.selectedStatus) {
            state.selectedStatus = selected.status;
            run(detailPane.update(selected));
        }
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
        state.selectedStatus = message.status;
        for (const row of messageList.querySelectorAll('.message-row')) {
            row.classList.toggle('is-selected', row.dataset.messageId === message.messageId);
        }
        return run(detailPane.show(message));
    }

    return { refresh, selectScope, selectFilter, selectMessage, detailPane, state };
}

async function main() {
    const tauri = window.__TAURI__;
    if (!tauri) return;

    const invoke = tauri.core.invoke;

    const inbox = createInbox({
        invoke,
        // Replies go out through `hitl-transport` on the shared topic, exactly
        // as any other device's do (spec §9.1). Nothing here records a status:
        // the reply is an event, and the next fold decides what it meant.
        actions: createReplyActions({ invoke }),
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
