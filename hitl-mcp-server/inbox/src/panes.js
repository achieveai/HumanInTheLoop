// Hand-set pane sizing: the collapse cycle and the drag handles.
//
// The counterpart to layout.js, and deliberately a separate module. There,
// `layout` is a function of viewport width and is never set by hand. Here both
// values are the opposite — set by hand, never by a breakpoint:
//
//   collapse    — 0, 1 or 2 panes hidden, counting from the left.
//   widths      — the two draggable column sizes, or null for "use the default".
//   readingPane — whether detail sits right of or below the list.
//   listHeight  — the draggable Bottom-mode list height, or the balanced default.
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
export const AGENTS_DEFAULT = 260;
export const LIST_MIN = 320;
export const DETAIL_MIN = 340;
export const LIST_HEIGHT_MIN = 180;
export const DETAIL_HEIGHT_MIN = 220;

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
export function clampWidths([first, second], total, firstFallback = 0) {
    const w1 = first === null ? null
        : clamp(first, AGENTS_MIN, Math.max(AGENTS_MIN, total - LIST_MIN - DETAIL_MIN));
    const used = w1 ?? firstFallback;
    const w2 = second === null ? null
        : clamp(second, LIST_MIN, Math.max(LIST_MIN, total - used - DETAIL_MIN));
    return [w1, w2];
}

/** Fit a remembered Bottom-mode list height to the available vertical space. */
export function clampListHeight(value, total) {
    if (value === null) return null;
    return clamp(value, LIST_HEIGHT_MIN, Math.max(LIST_HEIGHT_MIN, total - DETAIL_HEIGHT_MIN));
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
            readingPane: parsed?.readingPane === 'bottom' ? 'bottom' : 'right',
            listHeight: numberOrNull(parsed?.listHeight),
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
        storage?.setItem(STORAGE_KEY, JSON.stringify({
            collapse: state.collapse,
            widths: state.widths,
            readingPane: state.readingPane,
            listHeight: state.listHeight,
        }));
    } catch {
        // Same as above: losing the memory of a layout must not lose the layout.
    }
}

/**
 * Own the hand-set collapse, orientation, and divider sizes and publish them to CSS.
 *
 * `data-collapse` on the root drives which panes are shown; the custom
 * properties drive the first two widths and the Bottom-mode list height.
 * Everything else — which panes those attributes actually hide, and at which
 * widths they are consulted at all — is a decision CSS makes, not this module.
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
        readingPane: stored?.readingPane ?? 'right',
        listHeight: stored?.listHeight ?? null,
    };
    const listeners = new Set();

    function publish() {
        root.dataset.collapse = String(state.collapse);
        root.dataset.readingPane = state.readingPane;
        const [w1, w2] = fittedWidths();
        setWidth('--pane-1-width', w1);
        setWidth('--pane-2-width', w2);
        setWidth('--pane-list-height', clampListHeight(state.listHeight, totalHeight()));
        const snapshot = {
            collapse: state.collapse,
            widths: [...state.widths],
            readingPane: state.readingPane,
            listHeight: state.listHeight,
        };
        onChange?.(snapshot);
        listeners.forEach(listener => listener(snapshot));
    }

    function setWidth(property, value) {
        if (value === null) root.style.removeProperty(property);
        else root.style.setProperty(property, `${value}px`);
    }

    /** Total the three panes have to share. */
    const total = () => inbox?.clientWidth || root.clientWidth || 0;
    const totalHeight = () => inbox?.clientHeight || root.clientHeight || 0;

    // Stored values remain the user's preferences. Publishing fits temporary
    // CSS values to the current visible tracks, so a narrow/short responsive
    // round trip cannot erase sizes chosen for a larger desktop window.
    function fittedWidths() {
        if (root.dataset.layout !== 'wide') return [...state.widths];
        if (state.collapse === 0 && state.readingPane === 'bottom') {
            const first = state.widths[0] === null ? null
                : clamp(state.widths[0], AGENTS_MIN, Math.max(AGENTS_MIN, total() - DETAIL_MIN));
            return [first, state.widths[1]];
        }
        if (state.collapse === 0) return clampWidths(state.widths, total(), AGENTS_DEFAULT);
        if (state.collapse === 1 && state.readingPane === 'right') {
            return [state.widths[0], clampWidths([null, state.widths[1]], total())[1]];
        }
        return [...state.widths];
    }

    function applyWidths(widths, { persist = true, activeIndex = null } = {}) {
        const next = [numberOrNull(widths[0]), numberOrNull(widths[1])];
        if (activeIndex === 0 && next[0] !== null) {
            const reserved = state.readingPane === 'bottom' ? DETAIL_MIN : LIST_MIN + DETAIL_MIN;
            next[0] = clamp(next[0], AGENTS_MIN, Math.max(AGENTS_MIN, total() - reserved));
        }
        if (activeIndex === 1 && next[1] !== null) {
            const agent = root.dataset.layout === 'wide' && state.collapse === 0
                ? (fittedWidths()[0] ?? AGENTS_DEFAULT)
                : 0;
            next[1] = clamp(next[1], LIST_MIN, Math.max(LIST_MIN, total() - agent - DETAIL_MIN));
        }
        state.widths = next;
        publish();
        if (persist) writeStored(storage, state);
    }

    function applyListHeight(listHeight, { persist = true } = {}) {
        state.listHeight = clampListHeight(numberOrNull(listHeight), totalHeight());
        publish();
        if (persist) writeStored(storage, state);
    }

    function setCollapse(collapse) {
        state.collapse = clamp(collapse, 0, STEPS - 1);
        publish();
        writeStored(storage, state);
    }

    function setReadingPane(readingPane) {
        state.readingPane = readingPane === 'bottom' ? 'bottom' : 'right';
        publish();
        writeStored(storage, state);
    }

    return {
        state,
        cycle: () => setCollapse(nextCollapse(state.collapse)),
        expand: () => setCollapse(0),
        setCollapse,
        setReadingPane,
        toggleReadingPane: () => setReadingPane(state.readingPane === 'right' ? 'bottom' : 'right'),
        applyWidths,
        applyListHeight,
        /** Re-clamp against the current viewport, without recording anything new. */
        refit() {
            publish();
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
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
    readingPaneButton = document.getElementById('reading-pane-toggle'),
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
    on(readingPaneButton, 'click', () => {
        const scrollOwners = [doc.getElementById('message-list'), doc.querySelector('.detail-scroll')]
            .filter(Boolean)
            .map(element => ({
                element,
                top: element.scrollTop,
                left: element.scrollLeft,
            }));
        sizing.toggleReadingPane();
        const restoreScroll = () => scrollOwners.forEach(({ element, top, left }) => {
            element.scrollTo({ top, left });
        });
        restoreScroll();
        window.requestAnimationFrame(() => {
            restoreScroll();
            window.requestAnimationFrame(() => {
                restoreScroll();
            });
        });
    });

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
        if (handles[0] && list) {
            handles[0].style.top = '';
            handles[0].style.left = `${list.offsetLeft}px`;
        }
        if (handles[1] && detail) {
            if (sizing.state.readingPane === 'bottom') {
                handles[1].style.left = '';
                handles[1].style.top = `${detail.offsetTop}px`;
            } else {
                handles[1].style.top = '';
                handles[1].style.left = `${detail.offsetLeft}px`;
            }
        }
        updateControls();
    };

    function updateControls() {
        const [agents, list] = panes;
        const bottom = sizing.state.readingPane === 'bottom';
        if (readingPaneButton) {
            const label = bottom
                ? 'Place reading pane to the right of message list'
                : 'Place reading pane below message list';
            readingPaneButton.setAttribute('aria-label', label);
            readingPaneButton.title = label;
        }

        setSeparator(handles[0], {
            orientation: 'vertical',
            controls: 'pane-agents',
            min: AGENTS_MIN,
            max: Math.max(AGENTS_MIN, (inbox?.clientWidth ?? 0)
                - (bottom ? DETAIL_MIN : LIST_MIN + DETAIL_MIN)),
            now: agents?.offsetWidth ?? AGENTS_MIN,
        });
        if (bottom) {
            setSeparator(handles[1], {
                orientation: 'horizontal',
                controls: 'pane-list',
                min: LIST_HEIGHT_MIN,
                max: Math.max(LIST_HEIGHT_MIN, (inbox?.clientHeight ?? 0) - DETAIL_HEIGHT_MIN),
                now: list?.offsetHeight ?? LIST_HEIGHT_MIN,
            });
        } else {
            setSeparator(handles[1], {
                orientation: 'vertical',
                controls: 'pane-list',
                min: LIST_MIN,
                max: Math.max(LIST_MIN, (inbox?.clientWidth ?? 0) - (agents?.offsetWidth ?? 0) - DETAIL_MIN),
                now: list?.offsetWidth ?? LIST_MIN,
            });
        }
    }

    function setSeparator(handle, { orientation, controls, min, max, now }) {
        if (!handle) return;
        handle.setAttribute('role', 'separator');
        handle.tabIndex = 0;
        handle.setAttribute('aria-orientation', orientation);
        handle.setAttribute('aria-controls', controls);
        handle.setAttribute('aria-valuemin', String(Math.round(min)));
        handle.setAttribute('aria-valuemax', String(Math.round(max)));
        handle.setAttribute('aria-valuenow', String(Math.round(clamp(now, min, max))));
    }

    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(place) : null;
    if (observer && inbox) observer.observe(inbox);
    panes.forEach(pane => pane && observer?.observe(pane));
    disposers.push(() => observer?.disconnect());
    disposers.push(sizing.subscribe(place));

    on(window, 'resize', () => {
        sizing.refit();
    });

    place();

    function bindHandle(handle, index) {
        if (!handle) return;

        let startX = 0;
        let startY = 0;
        let base = [0, 0];
        let baseHeight = 0;
        let bottom = false;

        on(handle, 'pointerdown', (event) => {
            const [agents, list] = panes;
            startX = event.clientX;
            startY = event.clientY;
            bottom = index === 1 && sizing.state.readingPane === 'bottom';
            // Measured, not remembered: before the first drag these columns are
            // still `260px` and `1fr`, and only the browser knows what that
            // came out as.
            base = [agents?.offsetWidth ?? 0, list?.offsetWidth ?? 0];
            baseHeight = list?.offsetHeight ?? 0;
            handle.setPointerCapture(event.pointerId);
            handle.dataset.dragging = 'true';
            event.preventDefault();
        });

        on(handle, 'pointermove', (event) => {
            if (handle.dataset.dragging !== 'true') return;
            if (bottom) {
                sizing.applyListHeight(baseHeight + event.clientY - startY, { persist: false });
                return;
            }
            const dx = event.clientX - startX;
            const next = index === 0
                ? [base[0] + dx, sizing.state.widths[1]]
                : [sizing.state.widths[0], base[1] + dx];
            sizing.applyWidths(next, { persist: false, activeIndex: index });
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
            if (bottom) sizing.applyListHeight(sizing.state.listHeight);
            else sizing.applyWidths(sizing.state.widths, { activeIndex: index });
        };
        on(handle, 'pointerup', end);
        on(handle, 'pointercancel', end);

        on(handle, 'dblclick', () => {
            if (index === 1 && sizing.state.readingPane === 'bottom') {
                sizing.applyListHeight(null);
                return;
            }
            const widths = [...sizing.state.widths];
            widths[index] = null;
            sizing.applyWidths(widths, { activeIndex: index });
        });

        on(handle, 'keydown', (event) => {
            const [agents, list] = panes;
            const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 10
                : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -10
                    : 0;
            const isBottomList = index === 1 && sizing.state.readingPane === 'bottom';
            const axisKey = isBottomList
                ? event.key === 'ArrowUp' || event.key === 'ArrowDown'
                : event.key === 'ArrowLeft' || event.key === 'ArrowRight';
            if (!delta || !axisKey) return;
            event.preventDefault();
            if (isBottomList) {
                sizing.applyListHeight((list?.offsetHeight ?? LIST_HEIGHT_MIN) + delta);
            } else {
                const widths = [...sizing.state.widths];
                widths[index] = (index === 0 ? agents?.offsetWidth : list?.offsetWidth)
                    ?? (index === 0 ? AGENTS_MIN : LIST_MIN);
                widths[index] += delta;
                sizing.applyWidths(widths, { activeIndex: index });
            }
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
