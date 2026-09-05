# Inbox Interaction, Layout, and Rendered Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILLS: Use superpowers:subagent-driven-development to distribute the tasks and superpowers:test-driven-development for every production change.

**Goal:** Make Inbox actions immediate and recoverable, add composable message filters and a counted bulk-read action, reduce large-list resize stalls, offer Right/Bottom reading-pane layouts, and let users comment on and diff formatted Markdown while retaining raw source-line anchors.

**Architecture:** Keep the immutable event log and Rust projections authoritative. Add a small browser-side optimistic overlay over the latest server `MessageList`, park the selected detail DOM while its action is in flight, and reconcile the overlay when an authoritative `inbox-changed` refresh arrives. Keep the existing status tabs as one dimension and apply a second message-type dimension locally so combinations do not invoke another expensive native projection. Bulk-read uses one bounded native command but retains ordinary per-notification events; Undo publishes a targeted `restore_notification` event that cancels only the exact dismissal created by that operation. A bounded event-refresh coalescer and measured CSS containment keep large event waves and resize work from monopolizing the renderer. Extend the existing pane controller with a persisted Right/Bottom preference rather than mixing it into responsive navigation. Preserve raw Markdown and the existing line-anchor wire contract; use markdown-it block source maps for rendered selection and JsDiff to align complete rendered blocks without injecting diff markup into Markdown.

**Tech Stack:** Tauri v2, vanilla JavaScript ES modules, HTML `<dialog>`, Rust event-log projections, markdown-it 14.1.0, JsDiff 9.0.0, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-16-llm-inbox-design.md` §§4.2, 7.3, 8, 9.3. This plan intentionally revises the visible filter controls and strengthens the optimistic behavior described there.

## Global Constraints

- The event log remains the source of truth; optimistic state is a reversible browser overlay, never a database write.
- A valid action must remove or settle its row synchronously in the click turn. When it leaves the projection, preserve its old visible index: select the row now at that index, or the immediately previous row when the removed row was last. Never jump from the last row to the first.
- A rejected publish must restore the row in authoritative server order, preserve every typed question/review field, and open one modal error dialog.
- Client-side validation errors do not hide rows and do not open the transport-error dialog.
- An authoritative settlement from any device wins over a later local rejection; a settled row must never be resurrected.
- Plan-review `lost` and `unacknowledged` results are sent-but-not-confirmed outcomes, not transport failures. Restore their actionable row/draft using the existing review warning; reserve the modal for thrown publish errors.
- Status tabs are `All`, `Needs you`, and `Answered`. Message types are independent multi-select toggle buttons: `Notifications`, `Questions`, and `Review plans`.
- All message types are enabled by default and at least one type must remain enabled.
- Type changes are local and must not call `list_sessions`, `list_messages`, or any reply command.
- Keep Rust's legacy `notifications` filter parser for compatibility even though the visible mixed-dimension tab is removed.
- `Mark all read` targets pending/stale notification-type items in the currently selected All/Project/Session/Unattributed scope, independent of the active status/type controls. It appears in a distinct trailing list-actions region beside the type filters, is labelled `Mark all read (N)`, and requires no confirmation because every successful dismissal has a real Undo.
- Bulk read snapshots explicit scoped IDs, excluding any ID already in an optimistic single/bulk action, installs a prediction for every target (including currently hidden rows), performs one list DOM commit, invokes one native command with `MAX_IN_FLIGHT = 8`, keeps ordinary per-notification wire events, and aggregates partial failures without resurrecting authoritatively settled rows.
- Undo publishes targeted compensating events that name the exact dismissal IDs returned by the native command. It is persistent until used, explicitly dismissed, or superseded by a later bulk operation; dismissed notification details also expose `Mark unread` for later recovery.
- Only one bulk mark/undo command may be in flight globally. Scope changes may hide the originating controls but never let an old completion steal focus or replace new-scope status text.
- Tauri IPC is additively extended. The ntfy protocol gains one additive message type but existing message shapes and the protocol version remain unchanged; old clients safely ignore the unknown type.
- Large-list resize mitigation is limited to CSS rendering containment on message rows unless measurement disproves it; do not introduce a virtualization framework or a parallel list renderer.
- Reading-pane orientation is an explicit remembered `right|bottom` preference controlled independently of 3→2→1 collapse. Phone navigation ignores but preserves the preference.
- ReviewPlan defaults to formatted Changes, offers formatted Before & after plus raw Source through one switcher, and never changes the existing `{ path, startLine, endLine, side, comment }` wire contract.
- Rendered selections snap to the innermost intersecting Markdown block's 1-based inclusive raw line range. Do not claim character-exact anchoring; reject collapsed, outside-document, or mixed-old/new selections.
- Preserve ReviewPlan's `html:false`, remote-image placeholder, escaped-comment, and safe-link behavior. Bundle diff code locally; do not load runtime scripts from a CDN.
- Edit `client/src/review.js` and `review.css` as the shared sources; never hand-edit their generated Inbox copies.
- Preserve phone pane navigation behavior and the existing generation guards for out-of-order refreshes.
- Modify existing files; do not create alternate `v2`, `improved`, or `enhanced` implementations.
- Keep the implementation and diff deliberately small; reuse the existing render and selection paths instead of adding parallel state-management layers.
- Do not commit unless the user explicitly requests a commit.

---

### Task 1: Add the independent message-type filter row

**Files:**
- Modify: `hitl-mcp-server/inbox/src/pane-list.js`
- Modify: `hitl-mcp-server/inbox/src/inbox.js`
- Modify: `hitl-mcp-server/inbox/src/index.html`
- Modify: `hitl-mcp-server/inbox/src/inbox-harness.html`
- Modify: `hitl-mcp-server/inbox/src/inbox.css`
- Test: `hitl-mcp-server/inbox/tests/pane-list.spec.ts`
- Test support: `hitl-mcp-server/inbox/tests/fixtures.ts`

**Interfaces:**
- `FILTERS`: visible server-backed status tabs (`all`, `needs_you`, `answered`).
- `TYPES`: local type toggles (`notification`, `question`, `plan_review`).
- `filterMessagesByType(messages, enabledTypes) -> MessageRow[]`: pure local projection; `question` includes single and batch questions because both use `msgType === "question"`.
- `renderTypeFilterBar(container, messages, enabledTypes, { onToggle })`: stable-label buttons with `aria-pressed`; disables the final enabled button.
- `state.types: Set<string>`: defaults to all three and persists across scope/status refreshes.

- [ ] **Step 1: Write failing Playwright tests for the two filter dimensions**

Add focused cases to `pane-list.spec.ts`:

```ts
test('status and message type are independent filter dimensions', async ({ page }) => {
  await open(page, { messages: FILTERED_WITH_ALL_THREE_TYPES });

  await expect(page.locator('.filter-bar .filter')).toHaveText([
    /All/, /Needs you/, /Answered/,
  ]);
  await expect(page.locator('.type-filter')).toHaveText([
    /Notifications/, /Questions/, /Review plans/,
  ]);
  await expect(page.locator('.type-filter[aria-pressed="true"]')).toHaveCount(3);

  await page.locator('.type-filter[data-type="notification"]').click();
  await page.locator('.type-filter[data-type="plan_review"]').click();

  await expect(page.locator('.message-row')).toHaveCount(1);
  await expect(page.locator('.message-row')).toHaveAttribute('data-type', 'question');
});
```

Add separate tests proving:

- type toggles issue zero additional native invocations;
- the last enabled type is disabled and cannot produce an accidental empty combination;
- a type combination persists after a status-tab or agent-scope refresh;
- excluding the selected type chooses the adjacent surviving row by the same-index/previous-if-last rule and does not navigate a phone away from the list;
- an empty intersection says `Nothing matches these filters.`.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
cd B:\sources\Hitl_MCP\hitl-mcp-server\inbox
npx playwright test tests/pane-list.spec.ts
```

Expected failures: four visible status tabs still include `Notifications`; `.type-filter` does not exist; type combinations cannot be selected locally.

- [ ] **Step 3: Implement the minimal local type projection**

In `pane-list.js`, replace the visible `FILTERS` list with:

```js
export const FILTERS = [
    { key: 'all', label: 'All', count: list => list.counts.all },
    { key: 'needs_you', label: 'Needs you', count: list => list.counts.needsYou },
    { key: 'answered', label: 'Answered', count: list => list.counts.answered },
];

export const TYPES = [
    { key: 'notification', label: 'Notifications' },
    { key: 'question', label: 'Questions' },
    { key: 'plan_review', label: 'Review plans' },
];

export function filterMessagesByType(messages, enabledTypes) {
    return messages.filter(message => enabledTypes.has(message.msgType));
}
```

Render each type as a native `<button>` with stable text, `data-type`, and `aria-pressed`. When only one type is enabled, disable that pressed button until another type is enabled.

Add `#type-filter-bar` immediately below `#filter-bar` in both `index.html` and `inbox-harness.html`. Give it `role="group"` and `aria-label="Message types"`. Extend the fixture wiring so `createInbox` receives it.

In `inbox.js`, retain the latest authoritative list, apply `filterMessagesByType` before `renderMessageList`, and make `selectType` mutate only `state.types` and redraw from that retained list. Do not call `refresh()` from `selectType`.

In `inbox.css`, give the second row its own border, wrapping behavior, and pressed/unpressed states while preserving the compact phone layout.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run the same `pane-list.spec.ts` command. Expected: all pane-list tests pass.

---

### Task 2: Park and restore exact detail-pane state

**Files:**
- Modify: `hitl-mcp-server/inbox/src/pane-detail.js`
- Test: `hitl-mcp-server/inbox/tests/pane-detail.spec.ts`

**Interfaces:**
- `detailPane.park(messageId) -> boolean`: detach the currently painted detail DOM into a `DocumentFragment`, store it with its renderer controller, invalidate pending fetches, and return whether a pane was parked.
- `detailPane.restore(messageId) -> boolean`: replace the current pane with the parked DOM/controller without refetching or reconstructing form state.
- `detailPane.discard(messageId)`: permanently release a parked pane after authoritative confirmation.
- `detailPane.show(message)`: restore a parked pane for that message before considering a new `get_message` call.

- [ ] **Step 1: Write failing preservation tests**

Add Playwright cases that open a question, type free text/select an option, park it, open another message, then reopen the first message and assert the original DOM values remain. Add the equivalent plan-review case for overall feedback and an inline comment.

Name the production failure explicitly: replacing the detail container currently destroys question text because questions have no persisted draft store.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
npx playwright test tests/pane-detail.spec.ts --grep "parked detail"
```

Expected failure: `park`, `restore`, and `discard` are absent, or reopening performs a new render with empty values.

- [ ] **Step 3: Implement DOM parking without cloning**

Inside `createDetailPane`, keep a `Map<messageId, { fragment, painted }>`.

```js
function park(messageId) {
    if (!painted || painted.messageId !== messageId) return false;
    generation += 1;
    const fragment = document.createDocumentFragment();
    fragment.append(...container.childNodes);
    parked.set(messageId, { fragment, painted });
    painted = null;
    return true;
}
```

Restore the exact nodes rather than cloning them so input values, selection state, event listeners, review controller state, and detached async error handling survive. `show(message)` checks the parked map first. `discard(messageId)` deletes only that transaction's parked pane.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run the same parked-detail test command. Expected: both question and review values survive exactly, and reopening a parked message performs no extra `get_message` call.

---

### Task 3: Add the optimistic settlement transaction and failure dialog

**Files:**
- Modify: `hitl-mcp-server/inbox/src/inbox.js`
- Modify: `hitl-mcp-server/inbox/src/index.html`
- Modify: `hitl-mcp-server/inbox/src/inbox-harness.html`
- Modify: `hitl-mcp-server/inbox/src/inbox.css`
- Test: `hitl-mcp-server/inbox/tests/pane-detail.spec.ts`
- Test: `hitl-mcp-server/inbox/tests/reply.spec.ts`

**Interfaces:**
- `optimistic: Map<messageId, Transaction>` where `Transaction` contains the original row, predicted row, action label, originating scope/status, and phase (`sending` or `sent`).
- `beginOptimistic(row, predictedRow, actionLabel)`: capture the row's current visible index, park selected detail, install predicted state, synchronously redraw, and select the adjacent survivor at `min(oldIndex, remainingLength - 1)`.
- `rollbackOptimistic(messageId, error)`: remove the overlay, redraw the authoritative row in original order, retain its parked pane, and open the failure dialog unless an authoritative settlement already confirmed it.
- `confirmOptimistic(messageId)`: remove the overlay and discard parked detail after the log shows a terminal status.
- Wrapped actions preserve the existing `createReplyActions` return values and `myResponseId` behavior.

- [ ] **Step 1: Write failing immediate-success tests**

In the full Inbox harness, pin each reply command to an unresolved Promise. For Dismiss, question Submit/Skip, and plan-review verdict/Skip, click a valid action and assert before resolving the Promise:

- the original `Needs you` row is absent;
- exactly one next row is selected;
- pane 3 has already started showing that next row;
- only one reply command was issued;
- an unrelated `inbox-changed` refresh does not flash the optimistic row back.
- dismissing/marking the final visible notification selects its immediate previous neighbor, not the first row;

The assertion must be made while the transport Promise is unresolved; otherwise the test would pass with the current slow behavior.

- [ ] **Step 2: Run the immediate tests and verify RED**

Run:

```powershell
npx playwright test tests/pane-detail.spec.ts --grep "optimistic action"
```

Expected failure: the row remains present and selected until the authoritative event changes the list.

- [ ] **Step 3: Implement the optimistic overlay and wrapped actions**

Retain `latestList` before applying local projections. Render a row through its transaction's `predictedRow`, then apply the status filter semantics and type filter. Predicted statuses are:

- Dismiss notification: `dismissed`;
- Submit question: `answered`;
- Skip question: `skipped`;
- Submit review: `answered` plus its verdict;
- Skip review: `skipped`.

Because `Needs you` excludes terminal statuses, the row disappears synchronously there. Under `All`, the row stays in place with its predicted terminal status, preserving the meaning of the status dimension.

Wrap only transport actions (`onDismiss`, `onSubmit`, `onSkip`, `onSubmitReview`). Validation remains inside the existing renderers and occurs before a wrapper is called.

On an event-driven refresh, compare authoritative rows to transactions. A terminal authoritative row confirms the transaction. If the current server filter is `needs_you` and the row disappeared during that event-driven refresh, confirmation is also established. Explicit scope/status refreshes do not confirm transactions merely because their result omitted a row.

- [ ] **Step 4: Write failing rollback and race tests**

Add separate cases proving:

- a rejected Dismiss restores its row and opens the modal with the transport error;
- a rejected question Submit restores the row, and reopening it restores selected options and exact free text;
- a rejected plan-review submit restores the row, overall feedback, and inline comments;
- closing the dialog returns focus to the restored row when it is still in the current projection;
- an authoritative settlement arriving before a local rejection is never rolled back;
- review `lost` and `unacknowledged` results restore the actionable row/draft but do not open the send-failure modal;
- validation failures neither hide the row nor open the modal.

- [ ] **Step 5: Run rollback tests and verify RED**

Run:

```powershell
npx playwright test tests/pane-detail.spec.ts tests/reply.spec.ts --grep "rollback|authoritative settlement|validation"
```

Expected failure: no centralized modal exists, the row is not controlled by an optimistic transaction, and exact parked state cannot be restored.

- [ ] **Step 6: Implement the centralized error dialog and rollback**

Add one `<dialog id="action-error-dialog">` to both production and harness HTML with:

- title `Could not send`;
- a message element with `role="alert"`;
- a native `form method="dialog"` Close button.

`rollbackOptimistic` restores the authoritative projection first, then calls `showModal()`. Include the action label and the original error text. Never interpolate messages as HTML; assign `textContent`.

When the dialog closes, focus the restored row if it is visible; otherwise leave focus in the current pane. Existing inline renderer errors remain so reopening the parked form also explains the failure in context.

For plan-review results other than literal `received`, remove the optimistic overlay and restore the row without the modal. Let the parked review controller apply its existing `lost` or `unacknowledged` copy and keep the draft.

- [ ] **Step 7: Run the focused reply tests and verify GREEN**

Run:

```powershell
npx playwright test tests/pane-detail.spec.ts tests/reply.spec.ts
```

Expected: all optimistic, rollback, race, preserved-writing, and existing reply-contract tests pass.

---

### Task 4: Regression, accessibility, performance, and live verification

**Files:**
- Modify only if a failing regression requires it: files already listed above
- Record findings: `scratchpad/conversation_memories/dismissed_notification_reading_pane/research.md`

- [ ] **Step 1: Run static and focused verification**

```powershell
cd B:\sources\Hitl_MCP\hitl-mcp-server\inbox
git diff --check
npx playwright test tests/pane-list.spec.ts tests/pane-detail.spec.ts tests/reply.spec.ts
```

Expected: exit code 0. Type buttons have stable accessible names and truthful `aria-pressed`; the dialog has a labelled title and keyboard-operable Close button.

- [ ] **Step 2: Run the complete suites and native build**

```powershell
cd B:\sources\Hitl_MCP\hitl-mcp-server\inbox\src-tauri
cargo test
cargo build
cd ..
npx playwright test
```

Expected: all Rust and Playwright tests pass with no failures.

- [ ] **Step 3: Relaunch and manually test the real Inbox through Playwright**

Launch the development Inbox with WebView2 CDP on loopback port `9223`. Use an investigation-owned pending notification/question if available; do not mutate another task's request.

Measure from click to row disappearance while holding or observing the real send. Acceptance target: the DOM row leaves or changes terminal status in the same click turn and is observable by Playwright in under 300 ms, independent of ntfy latency.

Verify manually:

- rapid consecutive actions do not restore successful rows;
- a forced publish rejection restores the exact row/form and opens one dialog;
- all seven non-empty type combinations render correctly;
- type toggles cause no native command invocation;
- phone layout remains on the list when a background/filter reconciliation changes selection;
- dismissing the last visible row advances to its immediate previous neighbor;
- the application remains `Responding=True` and idle CPU returns to zero after activity.

- [ ] **Step 4: Record final evidence and notify completion**

Append automated counts, live timings, any remaining limitations, and artifact paths to the conversation research file. Send the mandatory HITL completion notifications for test/build completion and the finished task.

---

### Task 5: Add a targeted restore event and reversible notification fold

**Files:**
- Modify: `hitl-mcp-server/crates/hitl-transport/src/types.rs`
- Modify: `hitl-mcp-server/crates/hitl-transport/src/ntfy/publish.rs`
- Modify: `hitl-mcp-server/crates/hitl-transport/src/ntfy/mod.rs`
- Modify: `hitl-mcp-server/crates/hitl-transport/src/ntfy/dispatch.rs`
- Modify: `hitl-mcp-server/crates/hitl-store/src/events.rs`
- Modify: `hitl-mcp-server/crates/hitl-store/src/schema.rs`
- Modify: `hitl-mcp-server/crates/hitl-store/src/fold.rs`
- Modify: `hitl-mcp-server/crates/hitl-store/src/project.rs`
- Modify: `hitl-mcp-server/crates/hitl-store/tests/two_devices_agree.rs`
- Modify: `hitl-mcp-server/inbox/src-tauri/src/detail.rs`
- Modify if needed to keep the TypeScript union truthful: `hitl-mcp-server/server/src/types.ts`

**Wire interface:**

```json
{
  "type": "restore_notification",
  "messageId": "<new restore UUID>",
  "timestamp": 1788566400000,
  "notificationId": "<notification UUID>",
  "dismissalId": "<exact dismiss_notification UUID being undone>",
  "restoredFrom": "<configured device>"
}
```

- [ ] **Step 1: Write RED protocol, migration, fold, convergence, and detail tests**

Add exact serialization/parsing tests, safe unknown/future-version dispatch tests, and subject extraction tests. Add schema-v3 tests that upgrade an old database containing a valid previously-unknown restore with `subject_id IS NULL`, backfill it with `json_valid`/`json_extract`, tolerate malformed JSON, and prove fresh/upgraded schemas agree.

Use a table-driven fold test for: dismissal A; A + restore A; A + B + restore A; A + restore A + B; restore A ingested before A; duplicate restore; and an unknown dismissal ID. Add cross-device permutation tests. Restored notifications must fold to `Pending` with `responder`, `responded_at`, and `response_id` cleared; if B remains, B owns those fields. Detail must select only the settlement named by folded `row.responseId`, and return `settlement: null` after restoration.

- [ ] **Step 2: Verify RED, then implement the minimum additive protocol**

Run the focused transport/store/detail tests and capture the expected failures. Add the tolerant transport type, publisher, default no-op sink callback, supported dispatch route, too-new settlement classification, and `subject_of` mapping. Do not bump `protocolVersion` or alter frozen legacy shapes.

In the fold, collect restoration tombstones by exact `dismissalId` for the same notification, independent of arrival/sort order, then select the earliest non-tombstoned dismissal using the existing deterministic `(ntfy_time, ntfy_id)` order. A restore never becomes response attribution. Add schema v3 as a data backfill only—no table or column.

- [ ] **Step 3: Verify GREEN and review before Task 6**

Run the same focused tests, the complete transport/store Rust tests, TypeScript wire-compatibility tests if its union changed, and `git diff --check`. A fresh Sol implementer owns this task; a different Sol reviewer must approve protocol compatibility, migration safety, and convergence before Task 6 starts.

---

### Task 6: Add scoped native bulk dismiss/restore commands and actionable IDs

**Files:**
- Modify: `hitl-mcp-server/inbox/src-tauri/src/view.rs`
- Modify: `hitl-mcp-server/inbox/src-tauri/src/reply.rs`
- Modify: `hitl-mcp-server/inbox/src-tauri/src/main.rs`
- Modify: `hitl-mcp-server/crates/hitl-transport/src/ntfy/publish.rs`

**IPC interfaces:**

```text
DismissNotificationOutcome =
  { notificationId, status: "dismissed", responseId }
  | { notificationId, status: "failed", error }

RestoreNotificationOutcome =
  { notificationId, dismissalId, status: "restored", responseId }
  | { notificationId, dismissalId, status: "failed", error }
```

- `MessageList.actionableNotificationIds`: stable, deduplicated pending/stale notification IDs after scope and stale-display resolution, before status filtering.
- `dismiss_notifications(notificationIds)`: one Tauri invocation, `MAX_IN_FLIGHT = 8`, one ordinary dismissal event per ID.
- `restore_notifications([{ notificationId, dismissalId }])`: one Tauri invocation, the same bound, one targeted restore event per pair.

- [ ] **Step 1: Write RED projection and command-contract tests**

Use one table-driven Rust projection test for All, Project, Session, and Unattributed scopes across `all`, `needs_you`, `answered`, and legacy `notifications` filters. Assert dismissed and non-notification rows are excluded and exact serialized `MessageList` keys include the additive field.

Use an injected publisher to prove both commands deduplicate stable inputs, never exceed eight in flight, load configuration once, and return exactly one result per deduplicated input in input order even when completion order differs. Configuration/snapshot/global setup errors reject before any publish; after publishing starts, individual failures are tagged outcomes rather than a whole-command rejection.

- [ ] **Step 2: Implement the bounded native path**

Derive IDs during the existing fold/projection; do not add a second fold or accept a mutation scope string. Default a missing field to `[]` in browser fixtures for compatibility. Factor the existing single publish body just enough for reuse, preserving `dismiss_notification`. Reuse one bulk-local `reqwest::Client`, existing encryption/config state, and Tokio concurrency primitives; add no dependency and no new batching protocol. Generate response IDs and device attribution natively.

- [ ] **Step 3: Verify GREEN and review before Task 7**

Run focused view/reply tests, full native Rust tests, and `git diff --check`. A fresh Sol implementer owns this task; a different Sol reviewer must approve failure boundaries, ordering, the eight-request peak, and additive IPC compatibility before Task 7 starts.

---

### Task 7: Add the elegant counted bulk action, optimistic UI, and truthful Undo

**Files:**
- Modify: `hitl-mcp-server/inbox/src/index.html`
- Modify: `hitl-mcp-server/inbox/src/inbox-harness.html`
- Modify: `hitl-mcp-server/inbox/src/inbox.css`
- Modify: `hitl-mcp-server/inbox/src/reply.js`
- Modify: `hitl-mcp-server/inbox/src/inbox.js`
- Modify: `hitl-mcp-server/inbox/src/pane-list.js`
- Modify: `hitl-mcp-server/inbox/src/render-notification.js`
- Modify: `hitl-mcp-server/inbox/tests/fixtures.ts`
- Modify: `hitl-mcp-server/inbox/tests/pane-list.spec.ts`
- Modify: `hitl-mcp-server/inbox/tests/pane-detail.spec.ts`
- Modify: `hitl-mcp-server/inbox/tests/render-notification.spec.ts`
- Modify: `hitl-mcp-server/inbox/tests/reply.spec.ts`

**UI contract:**

- The outer filter/actions row is neutral. A nested `.type-filter-set` remains `role="group" aria-label="Message types"`; a separate `.list-actions` contains the bulk action. Do not use `role="toolbar"`.
- Idle with `N > 0`: `Mark all read (N)` is enabled. Its accessible description names the current scope and says status/type filters do not limit the action. At zero it is absent.
- Sending: retain the same logical focusable control, use `aria-disabled="true"` to block repeat activation, and label it `Marking N…`.
- Success: move focus to a persistent `Undo mark all read` button in a stable `role="status" aria-live="polite"` region before the Mark control disappears. Explain that marked items remain available under All/Answered.
- Partial dismiss title/body: `Some notifications weren’t marked read` and `Marked X of N notifications read. Y remain unread.` Append only the first sanitized reason. Undo contains successful `{notificationId, dismissalId}` pairs only.
- Partial restore title/body: `Some notifications weren’t marked unread` and `Marked X of N notifications unread. Y remain read.` Failed pairs remain available for retry and stay dismissed.
- Undo has no timeout. It remains until used, explicitly dismissed, or replaced by a later bulk operation. Dismissed notification detail also offers `Mark unread` against its folded response ID.
- One bulk command is globally in flight. If scope changes, new bulk actions remain busy and name the originating scope; an old completion may update predictions by ID but must not focus an old-scope row/control or overwrite new-scope status.

- [ ] **Step 1: Write the smallest composite RED tests**

Add one pane-list test combining semantic placement, `Mark all read (N)`, scope-wide count/filter independence, zero state, mobile wrapping, keyboard focus, and double-activation protection. Cover 320×568, 420×800, 599, and 600 px without horizontal overflow or a wrapping action label.

Add one bulk-success test proving synchronous same-click-turn prediction, one list render/`replaceChildren(fragment)` commit, one native invocation, correct adjacent selection, all-target predictions including hidden rows, exclusion of an unresolved single dismissal, and no flash when moving Answered → Needs you. Exact status behavior: Needs-you targets disappear; All targets remain predicted dismissed; Answered targets appear only as authoritative dismissals arrive; type-excluded notifications remain hidden while count/action stay scope-wide.

Add one combined partial-failure/race test proving stable-server-order rollback, aggregate copy, authoritative settlement wins, response IDs that arrive before the bulk Promise still refresh own-device detail attribution, Undo contains only successes, and `{ messageId, scopeKey }` focus restoration never steals focus after a scope change. Add one reply-contract test for exact camelCase arguments, keyed/missing/duplicate/unknown outcomes, and `myResponseId`. Add renderer coverage for dismissed → pending → dismissed footer/banner cleanup and individual `Mark unread`.

- [ ] **Step 2: Implement one optimistic transaction system**

Refactor the existing transaction value to `{ prediction, actionLabel, scopeKey }`; keep the removed visible index local and restore from authoritative `latestList`. Predictions are patches merged into authoritative rows. Install a transaction for every target ID, visible or hidden, but park only the selected visible detail. Build row/actionable maps once so reconciliation is O(T + M), not `.find` per target.

Exclude IDs already present in the optimistic map from the displayed count and bulk snapshot. Snapshot and deduplicate once, install all predictions, compute the adjacent non-target survivor, and make one synchronous list DOM commit before invoking native code. Treat unknown, duplicate, or missing native outcomes as failures. Remember successful response IDs, force one selected-detail attribution refresh after outcomes arrive, and let later authoritative state win over rollback.

Use the existing modal for one bounded partial-failure message and maintain a single global bulk state keyed by batch ID/origin scope. Preserve the same action DOM nodes across renders. Make the list-actions row full-width/right-aligned when wrapped and retain visible focus indicators. No confirmation dialog and no second bulk transaction map.

- [ ] **Step 3: Verify GREEN and review before Task 8**

Run the focused list/detail/renderer/reply suites, shared layout/panes regressions, and `git diff --check`. A fresh Sol implementer owns this task; a different Sol reviewer must approve optimistic races, truthful Undo, accessible focus/live status, mobile layout, and single-item regressions before Task 8 starts.

---

### Task 8: Bound event-refresh work and contain off-screen rows during resize

**Files:**
- Modify: `hitl-mcp-server/inbox/src/inbox.js`
- Modify: `hitl-mcp-server/inbox/src/inbox.css`
- Modify: `hitl-mcp-server/inbox/tests/pane-list.spec.ts`
- Modify: `hitl-mcp-server/inbox/tests/layout.spec.ts`
- Record benchmark: `scratchpad/conversation_memories/dismissed_notification_reading_pane/research.md`

- [ ] **Step 1: Write RED burst/coalescing and containment tests**

Add deterministic fake-timer coverage for the event scheduler: the first `inbox-changed` starts a burst, refresh after 100 ms of quiet, but force a refresh no later than 500 ms after the first event; events received while a projection is active collapse into one trailing refresh. A 500-event paced fixture must have bounded projection/list-commit counts and converge to the final authoritative rows.

Add one composite large-list test for computed styles plus cold/warm mixed-height rows: deep-scroll/select/focus the last row, deliver an event-driven full refresh, resize across existing breakpoints using web-first polling, and verify focus/navigation, accessible names, no overflow, scroll-height delta ≤1%, and bounded scroll-position/bounding-rect drift. Do not use timing assertions or `waitForTimeout` in Playwright.

- [ ] **Step 2: Implement only the exact measured controls**

Wrap the existing generation-safe `refreshAfterChange` entry with the 100 ms quiet/500 ms maximum scheduler; preserve one-active/one-trailing behavior and immediate explicit user refreshes. Add exactly these declarations to the existing `.message-row` rule:

```css
content-visibility: auto;
contain-intrinsic-size: auto 38px;
```

Do not add a resize scheduler, `will-change`, list virtualization, or a second renderer.

- [ ] **Step 3: Verify and benchmark before Task 9**

Run the focused burst test plus `pane-list.spec.ts`, `layout.spec.ts`, `panes.spec.ts`, and `git diff --check`. Run at least five alternating control/production 2,322-row resize bursts in the same real WebView2 environment, preserving cold/warm order and raw JSON. Acceptance: ≥30% median max-gap improvement, production median max gap ≤250 ms, median Ctrl+B ≤100 ms, scroll-height delta ≤1%, no console errors/overflow, and host `Responding=True`. Archive the exact script, row mix, WebView version, run order, and results. A fresh Sol implementer owns this task; a different Sol reviewer must approve scheduler bounds and layout evidence.

---

### Task 9: Add a remembered Right/Bottom reading-pane toggle

**Files:**
- Modify: `hitl-mcp-server/inbox/src/panes.js`
- Modify: `hitl-mcp-server/inbox/src/inbox.css`
- Modify: `hitl-mcp-server/inbox/src/index.html`
- Modify: `hitl-mcp-server/inbox/src/inbox-harness.html`
- Modify: `hitl-mcp-server/inbox/tests/panes.spec.ts`
- Modify: `hitl-mcp-server/inbox/tests/layout.spec.ts`

**State/API contract:**

- Extend the existing `localStorage["inbox.panes"]` object additively with `readingPane: "right" | "bottom"` and `listHeight`; missing/invalid legacy fields default to `right` and the existing balanced height.
- Publish `data-reading-pane="right|bottom"`; add `setReadingPane`, `toggleReadingPane`, and axis-specific list-height fitting. Keep existing `[agentWidth, listWidth]` untouched for Right.
- Add one compact toggle beside `#pane-cycle`, hidden on phone. In Right it is labelled `Place reading pane below message list`; in Bottom it is labelled `Place reading pane to the right of message list`. It changes neither collapse, selected message, scope/filter, nor phone `data-pane`.

- [ ] **Step 1: Write RED state, geometry, and interaction tests**

Cover default/legacy Right state, toggle to Bottom, independent width/height persistence, reload, height drag/clamp/double-click reset, both orientations across collapse 0/1/2 and wide/tablet/phone round trips, unchanged phone navigation, no overflow, and preserved list/detail scroll positions.

Make both divider buttons keyboard-focusable `role="separator"` controls. Assert dynamic `aria-orientation`, `aria-valuemin/max/now`, visible focus, and correct Left/Right versus Up/Down resizing. Handle 2 must clear stale `left`/`top` placement when its axis changes; Handle 1 remains the agent divider.

- [ ] **Step 2: Implement only pane-controller state and CSS grid placement**

Keep responsive ownership in `layout.js` unchanged. Let `panes.js` discover/bind the new toggle, persist the additive preference, clamp the active axis, and update separator metadata. In Bottom, agents span the rows while list sits above detail; when agents collapse, the list/detail stack fills the window; detail-only collapse remains detail-only. Reuse the existing list/detail divider and existing pane DOM—no wrapper, cloned pane, or alternate renderer.

- [ ] **Step 3: Verify GREEN and review before Task 10**

Run focused `panes.spec.ts` and `layout.spec.ts`, then the complete Inbox layout/list/detail tests and `git diff --check`. Exercise Right ↔ Bottom with the real app at wide/tablet/phone sizes. A fresh Sol implementer owns this task; a different Sol reviewer must approve persistence, geometry, responsive/collapse behavior, keyboard separators, and overlap safety.

---

### Task 10: Map selections in rendered Markdown to raw source-line comments

**Files:**
- Modify: `hitl-mcp-server/client/src/review.js`
- Modify: `hitl-mcp-server/client/src/review.css`
- Modify: `hitl-mcp-server/client/src/review-harness.html`
- Modify: `hitl-mcp-server/client/tests/review-anchors.spec.ts`
- Modify: `hitl-mcp-server/client/tests/review-window.spec.ts`
- Modify: `hitl-mcp-server/client/tests/review-security.spec.ts`
- Modify through the existing sync step: generated Inbox review assets
- Modify: `hitl-mcp-server/inbox/tests/render-review.spec.ts`

- [ ] **Step 1: Write RED rendered-selection mapping tests**

Instrument the existing markdown-it renderer so source-backed opening block tokens carry validated `data-source-start`, `data-source-end`, and fixed `data-source-side` attributes derived from zero-based half-open `token.map`. Add fixtures for ATX/setext headings, multiline paragraphs, nested lists/blockquote, tables, fenced code, CRLF/no-final-newline, reverse and multi-block selection, duplicate visible strings, and emoji. Expected output remains the existing 1-based inclusive raw line anchor; a selection inside a multiline block intentionally snaps to the entire block.

Test mouse/touch selection without immediate focus theft, keyboard block selection/commenting, link activation when no range is selected, comment highlight/`aria-describedby`, and rejection of collapsed, outside-document, generated-node, and mixed-side ranges. Keep the composer/comment cards outside rendered Markdown structure.

- [ ] **Step 2: Implement a reusable mapped-document controller**

Parse/render the complete document with the existing vendored markdown-it 14.1.0 and `html:false`. Prefer the innermost mapped blocks intersecting `Selection.getRangeAt(0)`, normalize minimum start/maximum end, and enable a persistent `Comment on selection` control without destroying mobile long-press selection. Preserve the current focused-block Arrow/Shift+Arrow/Enter path and the existing raw-row anchor path as Source fallback.

Do not add unified/mdast or an editor framework: the user selected block-line rather than character-exact anchors, and markdown-it already exposes the required block map. Preserve remote-image placeholders, safe links, escaped comments, and integer-only internal metadata. Run the existing asset-sync mechanism instead of editing generated Inbox copies.

- [ ] **Step 3: Verify GREEN and review before Task 11**

Run focused client anchor/window/security tests, the Inbox rendered-review smoke, asset-sync cleanliness, and `git diff --check`. A fresh Sol implementer owns this task; a different Sol reviewer must approve line semantics, selection edge cases, mobile/keyboard behavior, generated-asset discipline, and security.

---

### Task 11: Replace raw-plus-preview with formatted diff modes and Source fallback

**Files:**
- Add vendored upstream artifact/license: `hitl-mcp-server/client/src/vendor/diff.min.js` (JsDiff 9.0.0, BSD-3-Clause)
- Modify: `hitl-mcp-server/client/src/review.html`
- Modify: `hitl-mcp-server/client/src/review-harness.html`
- Modify: `hitl-mcp-server/client/src/review.js`
- Modify: `hitl-mcp-server/client/src/review.css`
- Modify: `hitl-mcp-server/client/tests/review-window.spec.ts`
- Modify: `hitl-mcp-server/client/tests/review-anchors.spec.ts`
- Modify: `hitl-mcp-server/client/tests/review-security.spec.ts`
- Modify through the existing sync step: generated Inbox review assets
- Modify: `hitl-mcp-server/inbox/tests/render-review.spec.ts`

**View contract:** one labelled switcher with `Changes` (default), `Before & after`, and `Source`.

- `Changes`: one reading-width formatted flow. Align arrays of complete top-level old/new rendered blocks with bounded JsDiff work; show equal current blocks once, removed old blocks with a red side rail and `Removed` text, and added new blocks with a green rail and `Added` text. Adjacent replacement blocks remain two complete blocks unless safe plain-text inline decoration preserves their source nodes.
- `Before & after`: render complete old and new documents independently with changed blocks highlighted and linked hunk navigation. On narrow layouts show one side at a time with a labelled Before/After toggle rather than squeezing columns.
- `Source`: retain the current unified-diff rows and all existing raw-line comment interactions as the exact syntax escape hatch.

- [ ] **Step 1: Write RED reconstruction/diff/mode tests**

Reconstruct old Markdown from context/deletion rows in the existing full-document unified diff. Cover new/all-added, unchanged synthetic context, deletion, replacement, diff-timeout fallback, CRLF, and no-final-newline markers. Assert Changes block order and old/new source sides; Before/After complete-document formatting; mode persistence within the open review; comment anchors in every mode; keyboard hunk navigation; narrow layout; and valid semantic DOM.

Explicitly surface visually silent source changes—link/image destinations, reference definitions, equivalent emphasis markers, list indentation/marker, table alignment, and rejected raw HTML—with a non-color-only `Source change; inspect Source` indicator. Reject a selection spanning old and new blocks. Test script/event-handler/unsafe-URL/DOM-clobbering fixtures.

- [ ] **Step 2: Implement the bounded formatted diff switcher**

Bundle JsDiff locally; no CDN. Parse old and new documents separately, decorate source-backed DOM only after safe rendering, then align/clone complete top-level blocks. Never inject `<ins>`/`<del>` or sentinel text into Markdown before parsing. Give deletions old coordinates, additions new coordinates, and unchanged blocks new coordinates. Collapse long unchanged regions only at block boundaries with stable reveal/focus controls.

Bound pathological diffs with JsDiff `timeout`/`maxEditLength`; fall back to formatted Before/After and Source rather than blocking the UI. Cache parsed documents for the open revision. Keep comment cards outside prose, provide explicit Added/Removed text plus color rails, and preserve find/draft/submit/verdict behavior unchanged.

- [ ] **Step 3: Verify GREEN, performance, and review before Task 12**

Run all client ReviewPlan tests, the Inbox review integration, generated-asset checks, and `git diff --check`. Record parse, diff, DOM-render, and selection costs on representative 1k/10k-line and all-changed documents; CI asserts deterministic max-work/fallback rather than wall-clock timing. Manually test mouse, keyboard, touch-width layout, all three modes, source-only changes, and saved comment anchors. A fresh Sol implementer owns this task; a different Sol reviewer must approve formatted-diff correctness, raw-line anchors, bounded performance, accessibility, security, and existing submit flow.

---

### Task 12: Final regression, owned live proof, and handoff

Run `git diff --check`, all Inbox and client Playwright tests, full Rust tests, server wire-compatibility tests, generated-asset checks, and native builds using task-specific C: artifact directories. Send the mandatory HITL notification after every test/build completion.

Relaunch the corrected Inbox. Create or preflight a dedicated scope containing exactly one investigation-owned pending notification. Measure click-to-removal synchronously and under 300 ms, wait for the authoritative dismissal, activate Undo, then force a fresh projection and prove the same notification is unread again without touching another request. Verify accessible bulk names/status/focus, 320/420 px wrapping, all seven type combinations, containment thresholds, zero console errors, and a defined 30-second idle CPU/Responding sample.

In the same real app, verify 3→2→1 collapse in both Right and Bottom orientations, persisted divider sizing, phone navigation, rendered selection → raw line anchors, Changes/Before & after/Source modes, old/new-side comments, source-only indicators, drafts, and final review submission. Leave the verified app running and do not delete existing WPR traces.

Use one final independent Sol whole-change reviewer after all task reviews. Resolve every Critical/Important finding through the same implementer → fresh reviewer loop, up to five rounds, before declaring completion.

---

## Self-Review

- Spec coverage: immediate optimistic state strengthens §9.3; parked DOM preserves its no-data-loss requirement; two-dimensional filters revise §7.3; reading-pane orientation extends rather than replaces the existing collapse/mobile model; formatted review preserves the established raw-line contract.
- Failure semantics: thrown publish errors roll back with a modal; validation errors stay local; sent-but-unconfirmed reviews retain their distinct existing state.
- Race semantics: an authoritative settlement always wins, including settlement by another device while the local request is in flight.
- Type consistency: production keys are exactly `notification`, `question`, and `plan_review`, matching `MessageRow.msgType` and `data-type`.
- Scope: existing wire shapes and the database schema stay compatible; the additive restore event, a schema-v3 subject backfill, one scoped actionable-ID field, and bounded native bulk commands are the minimum required for truthful cross-device Undo.
- Review rendering: markdown-it block maps satisfy the chosen line-level precision without a renderer migration; locally vendored JsDiff aligns complete rendered blocks while Source remains available for syntax-only changes.
- Placeholder scan: no TBD, TODO, or unspecified implementation step remains.
