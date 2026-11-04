// Participant identity for merged task conversations.
//
// One task (same title + objective) can be reported by many sub-agent
// sessions. Both the list and the thread label each session's messages with
// a short name and a stable color so the reader can tell judge-k from
// judge-j at a glance. Pure functions over row shapes — no DOM.

/**
 * The durable base label of the session a row belongs to:
 * `lmdotnettools-review-daemon/judge-k · 10c7` → `lmdotnettools-review-daemon/judge-k`.
 * Falls back through sessionKey; `null` when the row has neither.
 */
export function baseLabelOf(row) {
    const label = row.sessionLabel ?? row.sessionKey ?? '';
    const base = String(label).split(' · ')[0].trim();
    return base || null;
}

/** The short handle: the last path segment (`…/judge-k` → `judge-k`). */
export function shortNameOf(row) {
    const base = baseLabelOf(row);
    if (!base) return 'unknown';
    return base.split('/').pop();
}

/** FNV-1a — a stable, cheap hash so one label always gets one hue. */
function hashString(text) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash;
}

/**
 * One participant: the base label, a short name for chips, and a hue the
 * CSS turns into `oklch(...)` colors. Same label → same hue everywhere
 * (list chips, card chips, collapsed-line dots).
 */
export function participantOf(row) {
    const key = baseLabelOf(row) ?? 'unknown';
    return { key, name: shortNameOf(row), hue: hashString(key) % 360 };
}

/**
 * The distinct participants of a set of rows, newest activity first, each
 * with how many messages it contributed. Keys are the base labels.
 */
export function participantsOf(rows) {
    const byKey = new Map();
    for (const row of rows) {
        const participant = participantOf(row);
        const entry = byKey.get(participant.key)
            ?? { ...participant, count: 0, lastActivity: 0 };
        entry.count += 1;
        entry.lastActivity = Math.max(entry.lastActivity, row.createdAt ?? 0);
        byKey.set(participant.key, entry);
    }
    return [...byKey.values()]
        .sort((a, b) => (b.lastActivity - a.lastActivity) || a.name.localeCompare(b.name));
}
