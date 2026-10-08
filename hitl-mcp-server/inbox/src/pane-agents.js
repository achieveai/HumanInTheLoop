// Pane 1 — the agent tree (spec §6).
//
// Two levels, project → session, sorted by most recent activity, plus an
// "All agents" root and the `Unattributed` group for messages whose
// `sender_identity` has not joined yet (spec §5.5).
//
// The tree decides nothing. Session state, ordering, counts and the
// `Unattributed` grouping are all computed in the projection layer and arrive
// here already settled — so what this file can get wrong is limited to how it
// draws them, which is what the harness tests check. `recent` is settled there
// too; this file only hides rows that are not, until a search asks for them.

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
 * The rows to draw. Without a query: recent rows only (the projection's
 * `recent`), plus the selected row so a selection never vanishes. With one:
 * every project whose name matches, with all its sessions, and every session
 * whose label matches, however old.
 */
function visibleTree(tree, query, selectedScope) {
    const q = query.trim().toLowerCase();
    const matches = text => String(text ?? '').toLowerCase().includes(q);
    const projects = [];
    let hidden = 0;

    for (const project of tree.projects) {
        const projectHit = q !== '' && matches(project.name);
        const sessions = project.sessions.filter(session => {
            if (q) return projectHit || matches(session.label);
            const shown = session.recent !== false || session.scopeKey === selectedScope;
            if (!shown) hidden++;
            return shown;
        });
        const shown = q
            ? projectHit || sessions.length > 0
            : project.recent !== false || sessions.length > 0 || project.scopeKey === selectedScope;
        if (shown) projects.push({ ...project, sessions });
    }
    return { projects, hidden };
}

/** The last tree and options per container, so typing a query can redraw. */
const drawn = new WeakMap();

function drawTree(container, body, query) {
    const { tree, opts } = drawn.get(container);
    const now = tree.now;
    body.textContent = '';

    body.appendChild(agentRow({
        kind: 'root',
        scopeKey: tree.scopeKey,
        glyph: '',
        name: 'All agents',
        pending: tree.totalPending,
        now,
    }, opts));

    if (!tree.projects.length) {
        body.appendChild(el('p', 'agents-empty', 'No agents have said anything yet.'));
        return;
    }

    const { projects, hidden } = visibleTree(tree, query, opts.selectedScope);
    if (query.trim() && !projects.length) {
        body.appendChild(el('p', 'agents-empty', 'No agents or folders match.'));
        return;
    }

    for (const project of projects) {
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

        body.appendChild(group);
    }

    if (hidden > 0) {
        const noun = hidden === 1 ? 'agent' : 'agents';
        body.appendChild(el('p', 'agents-older',
            `${hidden} ${noun} quiet for over a week. Search to find them.`));
    }
}

/**
 * Render the tree.
 *
 * `tree` is exactly what `list_sessions()` returns. The search box is created
 * once and kept across redraws, so a live update never eats what was typed.
 */
export function renderAgentTree(container, tree, options = {}) {
    let search = container.querySelector(':scope > .agent-search');
    let body = container.querySelector(':scope > .agent-tree');
    if (!search || !body) {
        container.textContent = '';
        search = el('input', 'agent-search');
        search.type = 'search';
        search.placeholder = 'Search agents or folders';
        search.setAttribute('aria-label', 'Search agents or folders, including older ones');
        body = el('div', 'agent-tree');
        container.append(search, body);
        search.addEventListener('input', () => drawTree(container, body, search.value));
        search.addEventListener('keydown', event => {
            if (event.key !== 'Escape' || !search.value) return;
            event.stopPropagation();
            search.value = '';
            drawTree(container, body, '');
        });
    }

    drawn.set(container, { tree, opts: { selectedScope: 'all', ...options } });
    drawTree(container, body, search.value);
}
