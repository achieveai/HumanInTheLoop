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
function agentRow({ kind, scopeKey, glyph, name, label, hint, state, pending, lastEventAt, now }, options) {
    const row = el('div', `agent-row agent-row--${kind}`);
    // Grouping rows (a repo folder merged from several projects, a machine
    // subfolder) have no scope of their own — they only organise the tree.
    if (scopeKey) {
        row.dataset.scopeKey = scopeKey;
        row.setAttribute('role', 'button');
        row.tabIndex = 0;
    }
    if (state) {
        row.dataset.state = state;
        row.classList.add(`agent-row--${state}`);
    }
    if (scopeKey && scopeKey === options.selectedScope) row.classList.add('is-selected');

    const mark = el('span', 'agent-glyph', glyph ?? '');
    if (state) mark.title = state;
    row.appendChild(mark);

    const nameEl = el('span', 'agent-name', name);
    // A named session keeps its branch and id as small text, so two sessions
    // on one branch still differ.
    if (label) nameEl.appendChild(el('span', 'agent-label', label));
    if (hint) nameEl.title = hint;
    row.appendChild(nameEl);

    if (pending > 0) row.appendChild(el('span', 'agent-pending', String(pending)));

    if (lastEventAt) {
        const age = el('span', 'agent-age', formatAge(Math.max(0, now - lastEventAt)));
        age.title = formatAbsolute(lastEventAt);
        row.appendChild(age);
    }

    const select = () => { if (scopeKey) options.onSelect?.(scopeKey); };
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
 * whose label, details, or message content matches, however old.
 */
function visibleTree(tree, query, selectedScope, options = {}) {
    const q = query.trim().toLowerCase();
    const matches = text => String(text ?? '').toLowerCase().includes(q);
    const bodyOf = session => (options.bodyTextFor ? String(options.bodyTextFor(session) ?? '') : '');
    const projects = [];
    let hidden = 0;

    for (const project of tree.projects) {
        const projectHit = q !== '' && matches(project.name);
        const sessions = project.sessions.filter(session => {
            if (q) {
                return projectHit
                    || [session.label, session.sessionName, session.objective, session.machine, ...(session.formerNames ?? [])].some(matches)
                    || matches(bodyOf(session));
            }
            const shown = true; // Age filtering belongs to repository rows below.
            if (!shown) hidden++;
            return shown;
        });
        const shown = q
            ? projectHit || sessions.length > 0
            : true;
        if (shown) projects.push({ ...project, sessions });
    }
    return { projects, hidden };
}

/** Hover text for a session row: its objective, label, machine and earlier names. */
export function sessionHint(session) {
    const lines = session.sessionName
        ? [session.objective, session.label, onMachine(session.machine), formerly(session.formerNames)]
        : [onMachine(session.machine)];
    return lines.filter(Boolean).join('\n') || undefined;
}

/** "On Kay9", or '' when the sender's HITL is too old to say. */
export function onMachine(machine) {
    return machine ? `On ${machine}` : '';
}

/** "Formerly: A · B", newest first, or '' when a session was never renamed. */
export function formerly(names) {
    return names?.length ? `Formerly: ${names.join(' · ')}` : '';
}

/** The last tree and options per container, so typing a query can redraw. */
const drawn = new WeakMap();
const expandedMachines = new WeakMap();
const RECENT_REPOSITORY_SECONDS = 48 * 60 * 60;

/**
 * Folder names name the repository, not the checkout: worktrees arrive as
 * "repo/path · id", and the reader asked for repo folders with the machine
 * as the subfolder. A repo checked out on several machines gets one
 * subfolder per machine; a single-machine repo stays flat.
 */
function repoNameOf(name) {
    const stem = String(name ?? '').split('/')[0].trim();
    return stem || 'Unknown';
}

/** Merge projects into repo folders, sessions grouped by machine inside. */
function groupIntoRepos(projects) {
    const byRepo = new Map();
    for (const project of projects) {
        const name = repoNameOf(project.name);
        let repo = byRepo.get(name);
        if (!repo) {
            repo = { name, projects: [], unattributed: false };
            byRepo.set(name, repo);
        }
        repo.projects.push(project);
        repo.unattributed = repo.unattributed || !!project.unattributed;
    }
    const repos = [];
    for (const repo of byRepo.values()) {
        const sessions = repo.projects.flatMap(project => project.sessions);
        const merged = repo.projects.length > 1;
        const machines = new Map();
        for (const session of sessions) {
            const key = session.machine || '';
            if (!machines.has(key)) machines.set(key, []);
            machines.get(key).push(session);
        }
        const groups = [...machines.entries()].map(([machine, rows]) => ({
            machine,
            sessions: rows,
            pending: rows.reduce((total, s) => total + (s.pendingCount ?? 0), 0),
            lastEventAt: rows.reduce((max, s) => Math.max(max, s.lastEventAt ?? 0), 0) || null,
        })).sort((a, b) => (b.lastEventAt ?? 0) - (a.lastEventAt ?? 0));
        repos.push({
            ...repo,
            // A lone project keeps its scope, so its folder still selects.
            scopeKey: merged ? `repository:${repo.name}` : repo.projects[0].scopeKey,
            glyph: repo.projects[0]?.glyph,
            state: merged
                ? (sessions.some(s => s.state === 'waiting') ? 'waiting' : undefined)
                : repo.projects[0].state,
            pending: sessions.reduce((total, s) => total + (s.pendingCount ?? 0), 0),
            lastEventAt: sessions.reduce((max, s) => Math.max(max, s.lastEventAt ?? 0), 0) || null,
            groups,
        });
    }
    repos.sort((a, b) => (b.lastEventAt ?? 0) - (a.lastEventAt ?? 0));
    return repos;
}

function drawTree(container, body, query) {
    const { tree, opts } = drawn.get(container);
    if (!expandedMachines.has(container)) expandedMachines.set(container, new Set());
    const expanded = expandedMachines.get(container);
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

    const { projects, hidden } = visibleTree(tree, query, opts.selectedScope, opts);
    if (query.trim() && !projects.length) {
        body.appendChild(el('p', 'agents-empty', 'No agents, folders, or message content matches.'));
        return;
    }

    const machines = new Map();
    for (const repo of groupIntoRepos(projects)) {
        for (const sub of repo.groups) {
            const name = sub.machine || 'Unknown machine';
            if (!machines.has(name)) machines.set(name, []);
            machines.get(name).push({ repo, sub });
        }
    }
    for (const [machine, entries] of machines) {
        const group = el('div', 'agent-group');
        const heading = agentRow({
            kind: 'project',
            name: machine,
            pending: entries.reduce((sum, { sub }) => sum + sub.pending, 0),
            now,
        }, opts);
        heading.classList.add('agent-machine-heading');
        group.appendChild(heading);
        const older = entries.filter(({ sub }) => !sub.lastEventAt || now - sub.lastEventAt > RECENT_REPOSITORY_SECONDS);
        const visible = query.trim() || expanded.has(machine)
            ? entries : entries.filter(entry => !older.includes(entry));
        for (const { repo, sub } of visible) {
            group.appendChild(agentRow({
                kind: 'folder',
                scopeKey: repo.scopeKey,
                name: repo.name,
                glyph: repo.glyph,
                pending: sub.pending,
                lastEventAt: sub.lastEventAt,
                now,
            }, opts));
        }
        if (older.length && !query.trim()) {
            const more = el('button', 'agent-load-more', expanded.has(machine) ? 'Show less' : 'Load more…');
            more.type = 'button';
            more.setAttribute('aria-label', `${expanded.has(machine) ? 'Hide' : 'Show'} older repositories on ${machine}`);
            more.setAttribute('aria-expanded', String(expanded.has(machine)));
            more.addEventListener('click', () => {
                if (expanded.has(machine)) expanded.delete(machine);
                else expanded.add(machine);
                drawTree(container, body, query);
            });
            group.appendChild(more);
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
        search.placeholder = 'Search agents, folders, or message content';
        search.setAttribute('aria-label', 'Search agents, folders, or message content, including older ones');
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
