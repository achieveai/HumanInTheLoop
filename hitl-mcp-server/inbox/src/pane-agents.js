// Pane 1 — the agent tree (spec §6).
//
// Two levels, project → session, sorted by most recent activity, plus an
// "All agents" root and the `Unattributed` group for messages whose
// `sender_identity` has not joined yet (spec §5.5).
//
// The tree decides nothing. Session state, ordering, counts and the
// `Unattributed` grouping are all computed in the projection layer and arrive
// here already settled — so what this file can get wrong is limited to how it
// draws them, which is what the harness tests check.

import { formatAge, formatAbsolute } from './pane-list.js';

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
}

/**
 * One selectable row.
 *
 * `scopeKey` is passed straight through to `list_messages` — the UI never
 * composes one, it hands back whatever the tree was given. That is what keeps
 * the two commands from having to agree on a string format twice.
 */
function agentRow({ kind, scopeKey, glyph, name, state, pending, lastEventAt, now }, options) {
    const row = el('div', `agent-row agent-row--${kind}`);
    row.dataset.scopeKey = scopeKey;
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    if (state) {
        row.dataset.state = state;
        row.classList.add(`agent-row--${state}`);
    }
    if (scopeKey === options.selectedScope) row.classList.add('is-selected');

    const mark = el('span', 'agent-glyph', glyph ?? '');
    if (state) mark.title = state;
    row.appendChild(mark);

    row.appendChild(el('span', 'agent-name', name));

    if (pending > 0) row.appendChild(el('span', 'agent-pending', String(pending)));

    if (lastEventAt) {
        const age = el('span', 'agent-age', formatAge(Math.max(0, now - lastEventAt)));
        age.title = formatAbsolute(lastEventAt);
        row.appendChild(age);
    }

    const select = () => options.onSelect?.(scopeKey);
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
 * Render the tree.
 *
 * `tree` is exactly what `list_sessions()` returns.
 */
export function renderAgentTree(container, tree, options = {}) {
    const opts = { selectedScope: 'all', ...options };
    const now = tree.now;
    container.textContent = '';

    container.appendChild(agentRow({
        kind: 'root',
        scopeKey: tree.scopeKey,
        glyph: '',
        name: 'All agents',
        pending: tree.totalPending,
        now,
    }, opts));

    if (!tree.projects.length) {
        container.appendChild(el('p', 'agents-empty', 'No agents have said anything yet.'));
        return;
    }

    for (const project of tree.projects) {
        const group = el('div', 'agent-group');
        if (project.unattributed) group.classList.add('agent-group--unattributed');

        group.appendChild(agentRow({
            kind: 'project',
            scopeKey: project.scopeKey,
            glyph: project.glyph,
            name: project.name,
            state: project.state,
            pending: project.pendingCount,
            lastEventAt: project.lastEventAt,
            now,
        }, opts));

        for (const session of project.sessions) {
            group.appendChild(agentRow({
                kind: 'session',
                scopeKey: session.scopeKey,
                glyph: session.glyph,
                name: session.label,
                state: session.state,
                pending: session.pendingCount,
                lastEventAt: session.lastEventAt,
                now,
            }, opts));
        }

        container.appendChild(group);
    }
}
