/** Shared text-only work document. Both Tauri roots embed this via asset sync. */
function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text != null) element.textContent = String(text);
    if (className) element.className = className;
    return element;
}

export function workExpansion(container) {
    return new Set([...container.querySelectorAll('details[data-task-id][open]')].map(el => el.dataset.taskId));
}

export function renderWorkDocument(container, doc, expanded = workExpansion(container), summary = '') {
    const root = node('section', null, 'work-document');
    root.dataset.revision = doc.revision;
    function section(target, title, items, fallback = 'None reported.') {
        const block = node('section', null, 'work-section');
        block.append(node('h3', title));
        if (Array.isArray(items) && items.length) {
            const list = node('ul');
            for (const item of items) list.append(node('li', item));
            block.append(list);
        } else block.append(node('p', fallback, 'work-empty'));
        target.append(block);
    }
    section(root, 'Goal', [doc.goal]);
    if (summary) section(root, 'Update summary', [summary]);
    section(root, doc.revision === 1 ? 'What changed · Initial update' : 'What changed · Since previous update', doc.changes, 'No changes reported for this update.');
    const tasks = new Map((doc.tasks || []).map(task => [task.taskId, task]));
    const children = new Map();
    for (const task of tasks.values()) {
        if (!children.has(task.parentTaskId)) children.set(task.parentTaskId, []);
        children.get(task.parentTaskId).push(task);
    }
    const visited = new Set();
    function taskView(task, target) {
        if (visited.has(task.taskId)) return;
        visited.add(task.taskId);
        const stamp = new Date(task.reportedAt);
        const metadata = node('p', `${task.owner}${task.reportedBy && task.reportedBy !== task.owner ? ` - Reported by ${task.reportedBy}` : ''} · ${String(task.status).replaceAll('_', ' ')} · Reported `, 'work-freshness');
        const time = node('time', Number.isFinite(stamp.getTime()) ? stamp.toLocaleString() : 'unknown');
        if (Number.isFinite(stamp.getTime())) time.dateTime = stamp.toISOString();
        metadata.append(time);
        target.append(metadata);
        section(target, 'Completed', task.completed);
        section(target, 'Learned', task.learnings);
        section(target, 'Working now', task.current ? [task.current.action] : [], 'No current action reported.');
        if (task.current) section(target, 'Why', [task.current.purpose]);
        section(target, 'Still ahead', task.remaining);
        section(target, 'Blockers', task.blockers);
        for (const child of children.get(task.taskId) || []) {
            if (visited.has(child.taskId)) continue;
            const fold = node('details', null, 'work-task');
            fold.dataset.taskId = child.taskId;
            fold.open = expanded.has(child.taskId);
            fold.append(node('summary', `${child.taskId} · ${child.owner} · ${String(child.status).replaceAll('_', ' ')}`));
            taskView(child, fold);
            target.append(fold);
        }
    }
    const task = tasks.get(doc.rootTaskId);
    if (task) taskView(task, root);
    container.replaceChildren(root);
}
