# Inbox pane controls — resize and progressive collapse

Add two hand-set controls to the LLM Inbox: draggable pane widths, and a
collapse that hides the left pane, then the left and middle panes.

Branch: `master` (PR #7 merged, so all inbox work is here).

## 1. What already exists

Responsive layout landed in `12bbf56`. It works, and this plan does not
change it:

- **wide** (≥1100px) — three panes.
- **tablet** (600–1100px) — list + detail; the agent tree becomes an overlay.
- **phone** (<600px) — one pane, back-navigated.

`layout.js` holds two pieces of state that are deliberately kept apart:

- `layout` — a function of viewport width alone. Never set by hand.
- `pane` — which pane is frontmost when only one fits.

Keeping them independent is what makes "widen the window and your selection
survives" fall out for free.

## 2. Decisions already taken

These came from the questions answered on 2026-08-28. Recorded here so the
reasoning is not lost.

- **Collapse sticks across breakpoints.** Hide the left pane at desktop width,
  shrink to tablet, widen back — it is still hidden.
- **One control that steps 3 → 2 → 1**, not a toggle per pane.
- **Fullscreen is the end of that cycle**, not a separate mode. No extra
  chrome-hiding state, no second escape route to learn.

## 3. Design

### 3.1 New state, kept beside `layout`

A new module `inbox/src/panes.js`, sibling to `layout.js`. `layout.js` keeps
its single purpose; the hand-set state lives next to it, not inside it.

It owns two values:

- `collapse` — `0 | 1 | 2`. How many panes are hidden, counting from the left.
- `widths` — the two draggable column sizes.

It publishes `data-collapse` on the root element and sets two CSS custom
properties, `--pane-1-width` and `--pane-2-width`.

### 3.2 The grid becomes variable-driven

```css
.inbox {
    grid-template-columns:
        var(--pane-1-width, 260px)
        var(--pane-2-width, minmax(320px, 1fr))
        minmax(340px, 1.2fr);
}
[data-collapse='1'] .pane-agents { display: none }
[data-collapse='2'] .pane-agents,
[data-collapse='2'] .pane-list   { display: none }
```

The fallbacks are today's values, so an install with nothing stored looks
exactly as it does now.

### 3.3 How collapse meets the breakpoints

`collapse` is independent of `layout`, exactly as `pane` already is. That
independence is the whole reason the existing design survives a resize, and
this plan reuses it rather than working around it.

- **wide** — collapse applies. 3 → 2 → 1 panes.
- **tablet** — collapse applies. The agent tree is already an overlay, so
  `collapse: 1` is visually a no-op; `collapse: 2` leaves detail alone.
- **phone** — collapse is ignored. One pane already fits; `data-pane` governs.

### 3.4 Where the control lives

This is the only part of the change that alters the desktop look, so it is
called out rather than buried.

`.inbox-bar` is hidden entirely at wide widths today. A wide-only control
therefore has nowhere to live as things stand. The plan: show the bar at wide
carrying **only** a new `#pane-cycle` button. Back, ☰ and the title stay
hidden at wide, exactly as now.

Keyboard: `Ctrl/Cmd+B` steps the cycle. `Esc` returns to three panes.

**Alternative if that is unwelcome:** a floating control anchored to the shell,
leaving `.inbox-bar` untouched at wide. Cheaper visually, worse for
discoverability and keyboard focus order.

### 3.5 Resize — wide only

Two drag handles, between panes 1|2 and 2|3.

Deliberately not offered at tablet: the agent tree there is an overlay, so
there is one boundary and little to gain. Easy to extend later.

- Drags clamp to the existing `320px` / `340px` minimums, so a pane cannot be
  dragged into uselessness.
- Double-click a handle resets that boundary to its default.

### 3.6 Persistence

`collapse` and `widths` go in `localStorage`, so both survive a restart.

A stored width that no longer fits the current viewport is clamped on read,
not discarded — moving a window to a smaller screen should not silently throw
away the layout.

## 4. Tasks

Each task is test-first: write the failing test, watch it fail for the right
reason, then implement.

1. **`panes.js` state module** — `collapse` cycling, `widths` with clamping,
   `localStorage` read/write. Pure functions plus a small observable, mirroring
   `createPaneState`'s shape.
2. **CSS** — variable-driven grid, the two `data-collapse` rules, handle
   styling, and showing `.inbox-bar` at wide with only `#pane-cycle`.
3. **Markup** — `#pane-cycle` button and the two drag handles in `index.html`,
   and the same in `inbox-harness.html` so tests can reach them.
4. **Wiring** — construct the module in `inbox.js` next to `createPaneState`,
   bind the button, the handles, and the two keyboard shortcuts.
5. **Tests** — `inbox/tests/panes.spec.ts`.

## 5. Testing

Follows `layout.spec.ts`: drive a desktop browser at a chosen viewport. No
phone needed, because these are pane-count decisions rather than device
decisions.

Cases:

- Cycling steps 3 → 2 → 1 → 3, asserted through `data-collapse`.
- `Ctrl/Cmd+B` steps it; `Esc` returns to three panes.
- Dragging a handle changes the column width.
- A drag past the minimum clamps instead of collapsing the pane.
- Double-click resets a boundary.
- Collapse and widths survive a reload.
- Collapse survives a breakpoint round trip — wide → tablet → wide.
- Phone ignores collapse: `data-pane` still governs which pane is frontmost.
- A stored width wider than the viewport is clamped on read.

## 6. Files touched

| File | Change |
|---|---|
| `inbox/src/panes.js` | new |
| `inbox/tests/panes.spec.ts` | new |
| `inbox/src/inbox.css` | variable grid, collapse rules, handles, wide bar |
| `inbox/src/index.html` | cycle button, two handles |
| `inbox/src/inbox-harness.html` | same, for tests |
| `inbox/src/inbox.js` | wiring |

## 7. Open questions

1. **§3.4** — is showing `.inbox-bar` at wide acceptable, or do you want the
   floating control instead?
2. Unrelated to this plan: the `saveConfig` backup fix is committed on
   `claude/hitl-askquestion-verify-b84d57`, not on master. Want a PR for it?

## 8. Out of scope

- Resize handles at tablet.
- A distinct fullscreen mode, or hiding the top bar. Ruled out in §2.
- Any change to the existing breakpoints or to `layout.js`.
