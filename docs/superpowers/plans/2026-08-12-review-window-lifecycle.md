# Review Window Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close successfully completed ReviewPlan windows on every device without closing on provisional or losing responses and without destroying unsaved peer comments.

**Architecture:** Add a pure Rust correlator keyed by `responseId`. It combines live `plan_review_response` and authoritative `plan_review_ack` messages in either arrival order. Only a correlated `received` acknowledgement emits a local `review-completed` event. The Tauri shell owns close timers; the renderer remains platform-independent.

**Tech Stack:** Rust, Tauri v2, vanilla JavaScript, Playwright, Cargo tests.

## Global Constraints

- A `plan_review_ack` with `status: received` is the only completion authority.
- Submitter closes about 1 second after confirmed receipt.
- Peers close about 2 seconds after showing the completing device.
- A peer whose draft save failed remains open.
- `lost`, `unacknowledged`, losing, malformed, and uncorrelated messages never close windows.
- Cached response/ack messages do not create completion popups.
- Do not change any ReviewPlan wire shape or `protocolVersion`.

---

### Task 1: Add the pure completion correlator

**Files:**
- Create: `hitl-mcp-server/client/src-tauri/src/review_completion.rs`
- Modify: `hitl-mcp-server/client/src-tauri/src/main.rs`
- Test: inline Rust tests in `review_completion.rs`

**Interfaces:**
- Consumes: `PlanReviewResponseMessage`, `PlanReviewAckMessage` from `types.rs`.
- Produces:
  ```rust
  pub const ACK_CORRELATION_MARGIN: Duration = Duration::from_secs(15);
  pub enum CompletionOutcome {
      Pending,
      NoAction,
      Completed { review_id: String, responded_from: String, verdict: String },
  }
  pub struct ReviewCompletionCorrelator; // pending halves plus bounded resolved-ID tombstones
  impl ReviewCompletionCorrelator {
      pub fn new(window: Duration) -> Self;
      pub fn with_default_window() -> Self;
      pub fn observe_response(&self, response: PlanReviewResponseMessage) -> CompletionOutcome;
      pub fn observe_ack(&self, ack: PlanReviewAckMessage) -> CompletionOutcome;
  }
  ```

- [ ] **Step 1: Write failing tests for both arrival orders**

  Add tests that build a response with `message_id = "response-1"` and an ack with `response_id = "response-1"`. Assert response→ack and ack→response both produce `Completed` only on the second observation.

- [ ] **Step 2: Run the focused tests and confirm RED**

  Run:
  ```bash
  cd hitl-mcp-server/client/src-tauri
  cargo test review_completion -- --nocapture
  ```
  Expected: compilation fails because `review_completion` and its interfaces do not exist.

- [ ] **Step 3: Implement minimal correlation**

  Use `Mutex<HashMap<String, Entry>>`, where an entry stores one response or one ack and `Instant inserted_at`. Key only by `responseId`. A `received` match yields `Completed`; any other matched status yields `NoAction`; unmatched input yields `Pending`.

- [ ] **Step 4: Add failing edge-case tests**

  Cover:
  - `lost` ack removes the entry and yields `NoAction`.
  - Empty `response_id` never correlates.
  - Different response IDs never correlate.
  - Duplicate ack never completes twice.
  - Duplicate response after a completed pair never recreates a pending pair or emits completion again.
  - A response older than an injected 10 ms window cannot complete with a late ack.

- [ ] **Step 5: Implement expiry and exactly-once behavior**

  Sweep entries older than `window` at the start of each observation. `with_default_window()` uses the existing 30-second acknowledgement timeout plus `ACK_CORRELATION_MARGIN`. Keep bounded resolved-ID tombstones for the same window; either half for a resolved `responseId` returns `NoAction`. This prevents replay or duplicate delivery from rebuilding a completed pair.

- [ ] **Step 6: Run focused and full Rust tests**

  ```bash
  cargo test review_completion -- --nocapture
  cargo test
  ```
  Expected: all tests pass.

- [ ] **Step 7: Commit**

  ```bash
  git add hitl-mcp-server/client/src-tauri/src/review_completion.rs hitl-mcp-server/client/src-tauri/src/main.rs
  git commit -m "feat: correlate authoritative review completion"
  ```

---

### Task 2: Gate peer completion on the authoritative acknowledgement

**Files:**
- Modify: `hitl-mcp-server/client/src-tauri/src/ntfy.rs`
- Modify: `hitl-mcp-server/client/src-tauri/src/main.rs`
- Test: `hitl-mcp-server/client/src-tauri/src/review_completion.rs`

**Interfaces:**
- Consumes: `ReviewCompletionCorrelator` from Task 1.
- Produces local Tauri event:
  ```json
  { "reviewId": "...", "respondedFrom": "Kay9", "verdict": "approved" }
  ```
  under event name `review-completed`.

- [ ] **Step 1: Write a failing pure helper test for completion payload construction**

  Extract a helper in `ntfy.rs`:
  ```rust
  fn completion_payload(outcome: CompletionOutcome) -> Option<serde_json::Value>;
  ```
  Assert `Completed` maps to the exact JSON keys above and `Pending`/`NoAction` map to `None`.

- [ ] **Step 2: Run RED**

  ```bash
  cargo test completion_payload -- --nocapture
  ```
  Expected: helper is missing.

- [ ] **Step 3: Wire live dispatch**

  Register the correlator with Tauri state. In live `plan_review_response`, preserve the cache guard and own-device filter, then call `observe_response`; remove the immediate `review-superseded` emission. In live `plan_review_ack`, continue delivering to `AckWaiters`, also call `observe_ack`, and on `Completed` settle `OutstandingReviews` and emit `review-completed` through `notify_review_window`.

- [ ] **Step 4: Preserve cache behavior by structure**

  Keep both existing `Origin::Cache` early returns before any correlator call. Do not change `extract_answered_ids`; cached response/cancel messages continue suppressing reopening.

- [ ] **Step 5: Run Rust tests**

  ```bash
  cargo test completion_payload -- --nocapture
  cargo test review_completion -- --nocapture
  cargo test
  ```

- [ ] **Step 6: Commit**

  ```bash
  git add hitl-mcp-server/client/src-tauri/src/ntfy.rs hitl-mcp-server/client/src-tauri/src/main.rs
  git commit -m "fix: close peers only after winning review ack"
  ```

---

### Task 3: Close the submitting window after confirmed receipt

**Files:**
- Modify: `hitl-mcp-server/client/src/review-app.js`
- Test: `hitl-mcp-server/client/tests/review-shell.spec.ts`

**Interfaces:**
- Consumes: existing `onReceived` callback, invoked only for `status === "received"`.
- Produces: `getCurrentWindow().close()` after 1000 ms.

- [ ] **Step 1: Write failing Playwright tests**

  Add a test that submits an approved review with `status: received`, sees the success panel immediately, remains open before one second, then records `window.__windowClosed === true` after about 1100 ms. Add parameterized tests proving `lost` and `unacknowledged` remain open after 1200 ms.

- [ ] **Step 2: Run RED**

  ```bash
  cd hitl-mcp-server/client
  npx playwright test tests/review-shell.spec.ts -g "received submit|lost|unacknowledged"
  ```
  Expected: received case fails because no close is scheduled.

- [ ] **Step 3: Implement close scheduling**

  In `review-app.js`, obtain `getCurrentWindow` from `window.__TAURI__.window`. In `onReceived`, keep `clear_review_draft` fire-and-forget and schedule close after 1000 ms. Draft-clear failure logs visibly but does not delay or cancel close.

- [ ] **Step 4: Run GREEN**

  Run the focused command, then:
  ```bash
  npx playwright test tests/review-shell.spec.ts
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add hitl-mcp-server/client/src/review-app.js hitl-mcp-server/client/tests/review-shell.spec.ts
  git commit -m "fix: close submitted review window after receipt"
  ```

---

### Task 4: Add the peer-completed renderer state

**Files:**
- Modify: `hitl-mcp-server/client/src/review.js`
- Modify: `hitl-mcp-server/client/src/review-harness.html`
- Test: `hitl-mcp-server/client/tests/review-window.spec.ts`

**Interfaces:**
- Produces controller method:
  ```js
  setCompleted(device) // returns true when safe to close; false when draft save failed
  ```

- [ ] **Step 1: Write failing renderer tests**

  Replace the superseded fixture expectation with completion. Assert normal completion shows `Completed on Kay9`, disables controls, preserves displayed comments, and returns `true`. Force `noteDraftSaveFailed()`, then assert completion warns that comments were not saved and returns `false`.

- [ ] **Step 2: Run RED**

  ```bash
  npx playwright test tests/review-window.spec.ts -g "completion|draft-save failure"
  ```
  Expected: `setCompleted`/harness hooks are missing.

- [ ] **Step 3: Implement `setCompleted`**

  Set `resolved`, disable controls, render the composer, and show a `completed` banner. Return `false` only when `draftSaveFailed`; in that branch tell the human to copy comments before closing. Keep `setCancelled` unchanged.

- [ ] **Step 4: Update the harness**

  Expose `__simulateCompleted(device)` and `__forceDraftSaveFailed()`. Remove the obsolete `__simulateSuperseded` hook and its tests.

- [ ] **Step 5: Run GREEN and full window tests**

  ```bash
  npx playwright test tests/review-window.spec.ts
  ```

- [ ] **Step 6: Commit**

  ```bash
  git add hitl-mcp-server/client/src/review.js hitl-mcp-server/client/src/review-harness.html hitl-mcp-server/client/tests/review-window.spec.ts
  git commit -m "feat: render confirmed peer review completion"
  ```

---

### Task 5: Auto-close safe peer windows

**Files:**
- Modify: `hitl-mcp-server/client/src/review-app.js`
- Test: `hitl-mcp-server/client/tests/review-shell.spec.ts`

**Interfaces:**
- Consumes: local `review-completed` event and `controller.setCompleted()` boolean.
- Produces: close after 2000 ms only when the method returns `true`.

- [ ] **Step 1: Write failing shell tests**

  Emit `review-completed` with the active `reviewId` and `respondedFrom: "Kay9"`. Assert banner immediately, open before two seconds, closed after about 2100 ms. In a separate test, make `save_review_draft` reject, type a comment, emit completion, wait 2100 ms, and assert the window remains open with the copy-comments warning.

- [ ] **Step 2: Run RED**

  ```bash
  npx playwright test tests/review-shell.spec.ts -g "review-completed|draft-save failure"
  ```

- [ ] **Step 3: Replace the provisional event listener**

  Replace `review-superseded` with `review-completed`. Ignore mismatched review IDs. Call `setCompleted`; schedule close after 2000 ms only on `true`. Leave cancellation behavior untouched.

- [ ] **Step 4: Run GREEN and full client tests**

  ```bash
  npx playwright test tests/review-shell.spec.ts
  npx playwright test
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add hitl-mcp-server/client/src/review-app.js hitl-mcp-server/client/tests/review-shell.spec.ts
  git commit -m "fix: close completed peer review windows"
  ```

---

### Task 6: Final lifecycle verification

**Files:** No production changes expected.

- [ ] **Step 1: Run all automated checks**

  ```bash
  cd hitl-mcp-server/client/src-tauri && cargo test
  cd ../../ && npx playwright test
  cd ../server && npm test && npx tsc --noEmit && npm run build
  ```
  Expected: zero failures and zero TypeScript errors.

- [ ] **Step 2: Run mutation checks**

  Temporarily make `lost` produce `Completed`; confirm the losing-ack test fails. Revert. Temporarily return `true` from failed-draft completion; confirm the failed-draft shell test fails. Revert.

- [ ] **Step 3: Verify with two real clients**

  Start two clients on the same topic. Open one review. Submit on device A and confirm: A shows success then closes near one second; B shows `Completed on A` then closes near two seconds. Repeat with a forced draft-save failure on B and confirm B remains open.

- [ ] **Step 4: Commit any test-only corrections**

  ```bash
  git status --short
  ```
  Commit only if verification required legitimate tracked test corrections; do not commit runtime artifacts.
