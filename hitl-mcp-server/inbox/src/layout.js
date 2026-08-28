// Which panes are on screen, and how you get back to the one behind.
//
// Two independent pieces of state, deliberately kept apart (spec §4.2):
//
//   layout — a function of viewport width alone. Never set by hand.
//   pane   — which pane is frontmost when the layout can only show one.
//
// Keeping them independent is what makes "widen the window and your selection
// survives" fall out for free: resizing rewrites `layout` and never touches
// `pane`, so the multi-pane view comes back showing exactly what it showed
// before it collapsed.
//
// Breakpoints are pane-count decisions, not device decisions (spec §4) — a
// half-width desktop window is a tablet. That is what makes every one of these
// states reachable from a resize, and therefore testable without a phone.

/** Below this, one pane at a time. */
export const PHONE_MAX = 600;
/** At or above this, all three panes. */
export const WIDE_MIN = 1100;

/** Frontmost pane on phone. `list` is home: back always lands here. */
export const HOME_PANE = 'list';

export function layoutForWidth(width) {
    if (width >= WIDE_MIN) return 'wide';
    if (width >= PHONE_MAX) return 'tablet';
    return 'phone';
}

/**
 * Observe the viewport and publish the result as `data-layout` on the root.
 *
 * `matchMedia` is injected so a test can drive transitions without a real
 * resize; the app passes nothing and gets `window.matchMedia`.
 */
export function createLayoutObserver({
    root = document.documentElement,
    matchMedia = window.matchMedia.bind(window),
    onChange,
} = {}) {
    const wide = matchMedia(`(min-width: ${WIDE_MIN}px)`);
    const atLeastTablet = matchMedia(`(min-width: ${PHONE_MAX}px)`);

    function current() {
        if (wide.matches) return 'wide';
        if (atLeastTablet.matches) return 'tablet';
        return 'phone';
    }

    let last = null;
    function apply() {
        const now = current();
        root.dataset.layout = now;
        if (now !== last) {
            last = now;
            onChange?.(now);
        }
    }

    // `change` rather than polling: both queries fire on the same resize, and
    // `apply` is idempotent, so handling it twice costs one attribute write.
    wide.addEventListener('change', apply);
    atLeastTablet.addEventListener('change', apply);
    apply();

    return {
        current,
        apply,
        dispose() {
            wide.removeEventListener('change', apply);
            atLeastTablet.removeEventListener('change', apply);
        },
    };
}

/**
 * The navigation stack, such as it is.
 *
 * There is no history array because there is no history worth keeping: from
 * `detail` and from `agents` the only way back is `list`. Modelling that as a
 * stack would let it hold states no user can reach.
 */
export function createPaneState({ root = document.documentElement, onChange } = {}) {
    const state = { pane: HOME_PANE, agentsOpen: false };

    function publish() {
        root.dataset.pane = state.pane;
        root.dataset.agents = state.agentsOpen ? 'open' : 'closed';
        onChange?.({ ...state });
    }

    function show(pane) {
        state.pane = pane;
        // Selecting anything dismisses the overlay: on tablet the agent tree
        // is navigation, and navigation closes once it has been used.
        state.agentsOpen = false;
        publish();
    }

    function toggleAgents(open = !state.agentsOpen) {
        state.agentsOpen = open;
        if (open) state.pane = 'agents';
        else if (state.pane === 'agents') state.pane = HOME_PANE;
        publish();
    }

    /**
     * Move back exactly one pane.
     *
     * Returns whether it consumed the gesture. `false` means "nothing left to
     * go back to" — the caller decides what that means, which on Android is
     * "now you may exit" and on desktop is "do nothing" (spec §4.1).
     */
    function back() {
        if (state.agentsOpen) {
            toggleAgents(false);
            return true;
        }
        if (state.pane !== HOME_PANE) {
            show(HOME_PANE);
            return true;
        }
        return false;
    }

    publish();
    return { state, show, toggleAgents, back };
}
