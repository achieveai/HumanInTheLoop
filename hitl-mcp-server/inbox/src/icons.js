// Small inline SVG glyphs shared by the header badges, the thread cards and
// the reviewer. One stroke idiom — `currentColor`, 1.3 stroke, round caps —
// so a glyph drawn in a badge and the same glyph on a button are recognisably
// the same mark. Pure data plus a string helper: no DOM, no imports, which is
// what lets review.js (a deliberate no-dependencies module) use it too.

const ICONS = {
    machine: '<rect x="1.8" y="2.4" width="12.4" height="8.6" rx="1"/><path d="M5.6 13.6h4.8M8 11v2.6"/>',
    folder: '<path d="M1.5 3.4a1 1 0 0 1 1-1h3.3l1.6 1.6h6.6a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H2.5a1 1 0 0 1-1-1V3.4z"/>',
    branch: '<circle cx="4.2" cy="2.9" r="1.3"/><circle cx="4.2" cy="13.1" r="1.3"/><circle cx="12.4" cy="7" r="1.3"/><path d="M4.2 4.2v7.6M12.4 8.3c0 2.3-1.9 3.2-4.2 3.5"/>',
    send: '<path d="M14.7 1.3 7.3 8.7"/><path d="M14.7 1.3 10 14.7 7.3 8.7 1.3 5.3z"/>',
    expand: '<path d="M5.5 10.5 10.5 5.5"/><path d="M7.7 5.5h2.8v2.8"/><path d="M8.3 10.5H5.5V7.7"/>',
    collapse: '<path d="M5.5 10.5 10.5 5.5"/><path d="M6.9 6.3v2.8h2.8"/><path d="M9.1 9.7V6.9H6.3"/>',
    chevronDown: '<path d="m4 6 4 4 4-4"/>',
    chevronRight: '<path d="m6 4 4 4-4 4"/>',
    approve: '<path d="m3 8.5 3.5 3.5L13 5"/>',
    // The pencil stays inside the 16-grid: the old tip arc had a longer chord
    // than its diameter (a forced semicircle), which swung past x=16 and the
    // SVG viewport clipped the tip. Chord < 2r keeps the arc hugging the tip.
    changes: '<path d="M3.2 12.8 12.2 3.8a1.9 1.9 0 0 1 2.2 2.2L5.4 14.8l-2.6.4z"/><path d="M10.9 5.4 12.9 7.3"/>',
    reject: '<path d="M4 4l8 8M12 4l-8 8"/>',
    skip: '<path d="M3.3 2.7 10 8l-6.7 5.3z"/><path d="M12.7 2.7v10.6"/>',
    // "Acknowledged and filed" — the dismiss mark. A check inside a circle:
    // done, without borrowing the reject cross or the approve bare check.
    ack: '<circle cx="8" cy="8" r="6.4"/><path d="m5.4 8.2 1.9 1.9 3.6-4.1"/>',
};

/** The SVG markup for a glyph, drawn on a 16×16 grid in the shared stroke idiom. */
export function iconSvg(name, size = 11) {
    const body = ICONS[name] ?? '';
    return `<svg viewBox="0 0 16 16" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}
