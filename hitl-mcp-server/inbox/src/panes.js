// Hand-set pane sizing: the collapse cycle and the drag handles.
//
// The counterpart to layout.js, and deliberately a separate module. There,
// `layout` is a function of viewport width and is never set by hand. Here both
// values are the opposite — set by hand, never by width:
//
//   collapse — 0, 1 or 2 panes hidden, counting from the left.
//   widths   — the two draggable column sizes, or null for "use the default".
//
// Keeping them apart is what makes a collapse survive a resize: narrowing to
// tablet and widening back rewrites `layout` and never touches `collapse`, so
// the pane you hid is still hidden when the third column comes back.

/** Where both values live between runs. */
export const STORAGE_KEY = 'inbox.panes';

/** Floors for a drag. The list and detail values are the ones already in the
 *  grid's `minmax()`; a handle must not be able to do what only the collapse
 *  control is allowed to do. */
export const AGENTS_MIN = 180;
export const LIST_MIN = 320;
export const DETAIL_MIN = 340;

/** 0 → 1 → 2 → 0. Three panes, so three stops. */
export const STEPS = 3;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

/**
 * Fit stored widths to the viewport they are being restored into.
 *
 * Clamped rather than discarded: moving a window to a smaller screen should
 * cost you the extra pixels, not the whole layout. Applied in order, because
 * what pane 2 may take depends on what pane 1 already took.
 */
export function clampWidths([first, second], total) {
    const w1 = first === null ? null
        : clamp(first, AGENTS_MIN, Math.max(AGENTS_MIN, total - LIST_MIN - DETAIL_MIN));
    const used = w1 ?? 0;
    const w2 = second === null ? null
        : clamp(second, LIST_MIN, Math.max(LIST_MIN, total - used - DETAIL_MIN));
    return [w1, w2];
}

/** Next stop in the cycle. */
export const nextCollapse = (collapse) => (collapse + 1) % STEPS;

function readStored(storage) {
    try {
        const raw = storage?.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        const collapse = Number.isInteger(parsed?.collapse) ? clamp(parsed.collapse, 0, STEPS - 1) : 0;
        const widths = Array.isArray(parsed?.widths) ? parsed.widths : [null, null];
        return {
            collapse,
            widths: [numberOrNull(widths[0]), numberOrNull(widths[1])],
        };
    } catch {
        // A private window, cleared site data, or a browser set to refuse
        // storage. None of those are reasons to fail to draw the inbox.
        return null;
    }
}

const numberOrNull = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function writeStored(storage, state) {
    try {
        storage?.setItem(STORAGE_KEY, JSON.stringify({ collapse: state.collapse, widths: state.widths }));
    } catch {
        // Same as above: losing the memory of a layout must not lose the layout.
    }
}

/**
 * Own `collapse` and `widths`, and publish both to CSS.
 *
 * `data-collapse` on the root drives which panes are shown; the two custom
 * properties drive how wide the first two are. Everything else — which panes
 * those attributes actually hide, and at which widths they are consulted at all
 * — is a decision CSS makes, not this module.
 */
export function createPaneSizing({
    root = document.documentElement,
    inbox = document.querySelector('.inbox'),
    storage = window.localStorage,
    onChange,
} = {}) {
    const stored = readStored(storage);
    const state = {
        collapse: stored?.collapse ?? 0,
        widths: stored?.widths ?? [null, null],
    };

    function publish() {
        root.dataset.collapse = String(state.collapse);
        const [w1, w2] = state.widths;
        setWidth('--pane-1-width', w1);
        setWidth('--pane-2-width', w2);
        onChange?.({ collapse: state.collapse, widths: [...state.widths] });
    }

    function setWidth(property, value) {
        if (value === null) root.style.removeProperty(property);
        else root.style.setProperty(property, `${value}px`);
    }

    /** Total the three panes have to share. */
    const total = () => inbox?.clientWidth || root.clientWidth || 0;

    // Fit what was stored to the window it is being restored into, before it is
    // ever published. A layout saved on a wider screen is worth keeping at a
    // smaller size; it is not worth painting at its original size first.
    state.widths = clampWidths(state.widths, total());

    function applyWidths(widths, { persist = true } = {}) {
        state.widths = clampWidths(widths, total());
        publish();
        if (persist) writeStored(storage, state);
    }

    function setCollapse(collapse) {
        state.collapse = clamp(collapse, 0, STEPS - 1);
        publish();
        writeStored(storage, state);
    }

    return {
        state,
        cycle: () => setCollapse(nextCollapse(state.collapse)),
        expand: () => setCollapse(0),
        setCollapse,
        applyWidths,
        /** Re-clamp against the current viewport, without recording anything new. */
        refit: () => applyWidths(state.widths, { persist: false }),
        publish,
    };
}

/**
 * Wire the collapse button, the keyboard, and the two drag handles.
 *
 * Split from `createPaneSizing` so the state is testable without a DOM and the
 * DOM wiring has one place to live.
 */
export function bindPaneControls({
    sizing,
    cycleButton = document.getElementById('pane-cycle'),
    handles = [document.getElementById('pane-handle-1'), document.getElementById('pane-handle-2')],
    panes = [
        document.querySelector('.pane-agents'),
        document.querySelector('.pane-list'),
        document.querySelector('.pane-detail'),
    ],
    inbox = document.querySelector('.inbox'),
    doc = document,
} = {}) {
    const disposers = [];
    const on = (target, event, handler, options) => {
        target?.addEventListener(event, handler, options);
        disposers.push(() => target?.removeEventListener(event, handler, options));
    };

    on(cycleButton, 'click', () => sizing.cycle());

    on(doc, 'keydown', (event) => {
        if (isTyping(event.target)) return;
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') {
            event.preventDefault();
            sizing.cycle();
            return;
        }
        // Escape is shared with the plan reviewer's own handlers, so it is
        // claimed only when there is actually something collapsed to undo, and
        // never cancelled — the reviewer still sees it either way.
        if (event.key === 'Escape' && sizing.state.collapse !== 0) sizing.expand();
    });

    handles.forEach((handle, index) => bindHandle(handle, index));

    // Handles sit over the boundaries rather than in the grid: a fourth and
    // fifth grid child would change what the columns mean, and the boundary
    // moves for reasons other than a drag (a collapse, a window resize).
    const place = () => {
        const [, list, detail] = panes;
        if (handles[0] && list) handles[0].style.left = `${list.offsetLeft}px`;
        if (handles[1] && detail) handles[1].style.left = `${detail.offsetLeft}px`;
    };

    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(place) : null;
    if (observer && inbox) observer.observe(inbox);
    panes.forEach(pane => pane && observer?.observe(pane));
    disposers.push(() => observer?.disconnect());

    on(window, 'resize', () => {
        sizing.refit();
        place();
    });

    place();

    function bindHandle(handle, index) {
        if (!handle) return;

        let startX = 0;
        let base = [0, 0];

        on(handle, 'pointerdown', (event) => {
            const [agents, list] = panes;
            startX = event.clientX;
            // Measured, not remembered: before the first drag these columns are
            // still `260px` and `1fr`, and only the browser knows what that
            // came out as.
            base = [agents?.offsetWidth ?? 0, list?.offsetWidth ?? 0];
            handle.setPointerCapture(event.pointerId);
            handle.dataset.dragging = 'true';
            event.preventDefault();
        });

        on(handle, 'pointermove', (event) => {
            if (handle.dataset.dragging !== 'true') return;
            const dx = event.clientX - startX;
            const next = index === 0
                ? [base[0] + dx, base[1]]
                : [base[0], base[1] + dx];
            sizing.applyWidths(next, { persist: false });
            place();
        });

        const end = (event) => {
            if (handle.dataset.dragging !== 'true') return;
            delete handle.dataset.dragging;
            try {
                handle.releasePointerCapture(event.pointerId);
            } catch {
                // Already released — the drag ended outside the window.
            }
            // Recorded once, at the end: a drag is one decision, not sixty.
            sizing.applyWidths(sizing.state.widths);
            place();
        };
        on(handle, 'pointerup', end);
        on(handle, 'pointercancel', end);

        on(handle, 'dblclick', () => {
            const widths = [...sizing.state.widths];
            widths[index] = null;
            sizing.applyWidths(widths);
            place();
        });
    }

    return {
        place,
        dispose() {
            disposers.forEach(off => off());
        },
    };
}

function isTyping(target) {
    if (!target || typeof target.tagName !== 'string') return false;
    const tag = target.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || target.isContentEditable === true;
}
