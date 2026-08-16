# Sender Identity Metadata Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show an always-visible sender label (machine + worktree/session/path) on every dialog, notification, and plan review window, without touching the four byte-frozen legacy wire shapes.

**Architecture:** A pure resolver (`identity.ts`) computes a `{ label, source }` sender identity per outgoing message from the same cwd each tool already resolves, with session-name > linked-worktree > path-fallback precedence. Questions and notifications carry identity as a new, non-union `sender_identity` companion message, published right after the message it decorates and correlated client-side by a bounded `forMessageId` cache. Plan reviews carry `sender` inline on `PlanReviewMessage` (already protocol v2, already tolerant of new optional fields). All three window renderers add a badge outside any collapsible section.

**Tech Stack:** TypeScript/Node.js (server), Rust/Tauri (client), vanilla JavaScript (renderer), Jest, Cargo tests, Playwright.

## Global Constraints

- `question`, `answer`, `notification`, and `dismiss_notification` stay byte-for-byte compatible; they never gain a `sender` field or `protocolVersion`. Sender identity for them travels only as the separate `sender_identity` message.
- `sender_identity` is never added to the `HitlMessage` union.
- `identityEnabled` defaults to `true` and is defaulted with `parsed.identityEnabled !== false` — never the `deviceName`-style `||` idiom, which would evaluate truthy even when a user explicitly set `identityEnabled: false`.
- Identity content (label, source) only ever travels inside the encrypted message body. It is never a new plaintext ntfy header, and a label is never an absolute path (F-9) — the path-fallback tier truncates to the last two segments before serialization.
- No new cwd concept: `AskUserQuestion`/`Notify` resolve identity from `process.cwd()`; `ReviewPlan` resolves it from `path.dirname(plan.resolvedPath)`, matching each tool's existing repo-context call exactly.
- Identity is decoration only — nothing waits on it, retries for it, or fails without it. A `sender_identity` that never finds a matching window/cache entry is dropped silently.
- The pluggable session-name resolver ships returning `null` only; no real resolver is implemented in this change.
- No persistence of sender identity into `snapshot-store.ts`; no auth/spoofing protection; no i18n.

---

### Task 1: Detect linked git worktrees in `git-context.ts`

**Files:**
- Modify: `hitl-mcp-server/server/src/git-context.ts`
- Create: `hitl-mcp-server/server/src/__tests__/git-context.test.ts`

**Interfaces:**
```ts
export function isLinkedWorktree(cwd?: string): boolean;
```
- Extract the `run()` helper currently inlined inside `detectRepoContext` (execSync, `stdio: 'pipe'`, 5000ms timeout, trims stdout, swallows errors) to module scope so both functions share it without duplicating the idiom.

- [ ] **Step 1: Write failing worktree-detection tests**

  Follow this repo's established convention for `git-context.ts`-adjacent tests (`plan-diff.test.ts`, `snapshot-store.test.ts`): spin up **real temporary git repos** with real `execSync` calls rather than mocking `child_process`. Add an `initRepo(dir)` helper (init, set `user.email`/`user.name`). Cover:
  - Main working tree (no worktrees) → `isLinkedWorktree(repoDir)` is `false`.
  - A linked worktree created via `git worktree add <path> <branch>` → `isLinkedWorktree(worktreePath)` is `true`.
  - A non-git temp directory → `false` (tolerated, no throw).
  - A `cwd` argument omitted → uses `process.cwd()` (assert by `cwd`-ing the test process into the temp repo via `execSync(..., { cwd })`, not by mutating `process.cwd()` globally).

- [ ] **Step 2: Run RED**

  ```bash
  cd hitl-mcp-server/server
  npm test -- src/__tests__/git-context.test.ts
  ```
  Expected: `isLinkedWorktree` is not exported.

- [ ] **Step 3: Extract the shared `run()` helper and implement `isLinkedWorktree`**

  Move the existing local `run()` const out of `detectRepoContext` to module scope (same signature, same try/catch/timeout behavior — no behavior change for `detectRepoContext`). Implement:
  ```ts
  export function isLinkedWorktree(cwd: string = process.cwd()): boolean {
    const gitDir = run(`git rev-parse --git-dir`, cwd);
    const gitCommonDir = run(`git rev-parse --git-common-dir`, cwd);
    if (gitDir === undefined || gitCommonDir === undefined) return false;
    return path.resolve(cwd, gitDir) !== path.resolve(cwd, gitCommonDir);
  }
  ```
  They are equal in the main working tree or a non-worktree repo, and differ in a linked worktree — resolve both to absolute paths before comparing since git may emit either relative or absolute output depending on platform/version.

- [ ] **Step 4: Run GREEN, plus a regression check on the refactored helper**

  ```bash
  npm test -- src/__tests__/git-context.test.ts
  npm test -- src/__tests__/wire-compat.test.ts
  ```
  The second command guards `detectRepoContext`'s existing behavior (its "question construction" test asserts on the live `repo` field) since `run()` was extracted, not just added to.

- [ ] **Step 5: Commit**

  ```bash
  git add hitl-mcp-server/server/src/git-context.ts hitl-mcp-server/server/src/__tests__/git-context.test.ts
  git commit -m "feat: detect linked git worktrees for identity resolution"
  ```

---

### Task 2: Resolve sender identity label tiers

**Files:**
- Modify: `hitl-mcp-server/server/src/types.ts`
- Create: `hitl-mcp-server/server/src/identity.ts`
- Create: `hitl-mcp-server/server/src/__tests__/identity.test.ts`

**Interfaces:**
- In `types.ts` (canonical shape, so the wire type added in Task 4 and this resolver share one definition instead of two drifting copies):
  ```ts
  export type SenderIdentitySource = 'session' | 'worktree' | 'path';
  export interface SenderIdentity {
    label: string;
    source: SenderIdentitySource;
  }
  ```
- In `identity.ts`:
  ```ts
  export type SessionNameResolver = () => string | null;

  /** No documented Claude Code env var exposes a human-readable session name today — only a UUID. This seam lets a real resolver replace this default without touching call sites. */
  export const defaultSessionNameResolver: SessionNameResolver = () => null;

  export function resolveSenderIdentity(
    cwd: string,
    deviceName: string,
    sessionResolver: SessionNameResolver = defaultSessionNameResolver
  ): SenderIdentity;
  ```
  Purely a function of its arguments — it never reads `process.cwd()` or `os.hostname()` itself, so callers control (and tests can mock) both cwd and device name, and per-tool cwd rules live at each call site (Tasks 4/5), not inside the resolver.

- [ ] **Step 1: Write failing resolver tests**

  Reuse the real-temp-git-repo `initRepo` helper from Task 1. Cover, in precedence order:
  - Session resolver returns a non-null value → that value used verbatim as `label`, `source: 'session'`, regardless of whether `cwd` is also a linked worktree or a plain path.
  - `cwd` is a linked worktree (git worktree add) → `label` is `` `${deviceName} - ${branch}` ``, `source: 'worktree'`, branch obtained via the existing `git branch --show-current` idiom (via `detectRepoContext(cwd)?.branch`, not a duplicated git call).
  - `cwd` is a non-worktree git repo (main working tree) → path-fallback tier, not worktree tier (only *linked* worktrees get the branch-based label).
  - `cwd` is a non-git directory → path-fallback tier.
  - Path-fallback label is `` `${deviceName} ${lastTwoSegments}` `` joined with `/`, never an absolute path, and normalizes platform separators (test with a path built via `path.join` and assert the label contains no `path.sep` when `path.sep !== '/'`).
  - A `cwd` with only one path segment still produces a valid (non-crashing) label using whatever segments exist.

- [ ] **Step 2: Run RED**

  ```bash
  npm test -- src/__tests__/identity.test.ts
  ```
  Expected: `identity.ts` and its exports do not exist.

- [ ] **Step 3: Implement the resolver**

  ```ts
  function lastTwoSegments(cwd: string): string {
    const segments = cwd.split(/[\\/]/).filter(Boolean);
    return segments.slice(-2).join('/');
  }

  export function resolveSenderIdentity(
    cwd: string,
    deviceName: string,
    sessionResolver: SessionNameResolver = defaultSessionNameResolver
  ): SenderIdentity {
    const sessionName = sessionResolver();
    if (sessionName !== null) return { label: sessionName, source: 'session' };

    if (isLinkedWorktree(cwd)) {
      const branch = detectRepoContext(cwd)?.branch;
      if (branch) return { label: `${deviceName} - ${branch}`, source: 'worktree' };
    }

    return { label: `${deviceName} ${lastTwoSegments(cwd)}`, source: 'path' };
  }
  ```
  If `isLinkedWorktree` is `true` but `detectRepoContext` unexpectedly returns no branch (race/edge case), fall through to the path tier rather than emitting a malformed label.

- [ ] **Step 4: Run GREEN and type-check**

  ```bash
  npm test -- src/__tests__/identity.test.ts
  npx tsc --noEmit
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add hitl-mcp-server/server/src/types.ts hitl-mcp-server/server/src/identity.ts hitl-mcp-server/server/src/__tests__/identity.test.ts
  git commit -m "feat: resolve sender identity label tiers"
  ```

---

### Task 3: Add the `identityEnabled` config flag

**Files:**
- Modify: `hitl-mcp-server/server/src/types.ts` (`HitlConfig`)
- Modify: `hitl-mcp-server/server/src/config.ts` (`loadConfig`, `generateDefaultConfig`)
- Create: `hitl-mcp-server/server/src/__tests__/config.test.ts`

**Interfaces:**
```ts
export interface HitlConfig {
  // ...existing fields...
  identityEnabled?: boolean;
}
```

- [ ] **Step 1: Write failing config-default tests**

  `config.ts` always resolves `CONFIG_DIR`/`CONFIG_FILE` from `homedir()` (unlike `ntfy-transport.ts`/`snapshot-store.ts`, it does **not** honor `HITL_HOME`), so mock `os.homedir` and `fs` the same way `host-settings.test.ts`/`cli.test.ts` do:
  ```ts
  jest.unstable_mockModule('os', () => ({ homedir: jest.fn(() => '/mock/home'), hostname: jest.fn(() => 'test-host') }));
  jest.unstable_mockModule('fs', () => ({ existsSync: mockExistsSync, readFileSync: mockReadFileSync, writeFileSync: mockWriteFileSync, mkdirSync: mockMkdirSync }));
  const { loadConfig } = await import('../config.js');
  ```
  Cover:
  - Config JSON with no `identityEnabled` key → `loadConfig().identityEnabled === true`.
  - Config JSON with `identityEnabled: true` → `true`.
  - Config JSON with `identityEnabled: false` → `false` (this is the case a naive `||` default would silently defeat).
  - `generateDefaultConfig().identityEnabled === true`.

- [ ] **Step 2: Run RED**

  ```bash
  npm test -- src/__tests__/config.test.ts
  ```
  Expected: `identityEnabled` is `undefined`, not defaulted.

- [ ] **Step 3: Implement the default**

  In `loadConfig`, add `identityEnabled: parsed.identityEnabled !== false,` alongside the existing `soundEnabled: parsed.soundEnabled !== false,` line — same idiom, same reasoning. In `generateDefaultConfig`, add `identityEnabled: true,`.

- [ ] **Step 4: Run GREEN and type-check**

  ```bash
  npm test -- src/__tests__/config.test.ts
  npx tsc --noEmit
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add hitl-mcp-server/server/src/types.ts hitl-mcp-server/server/src/config.ts hitl-mcp-server/server/src/__tests__/config.test.ts
  git commit -m "feat: add identityEnabled config flag"
  ```

---

### Task 4: Publish sender identity alongside questions and notifications

**Files:**
- Modify: `hitl-mcp-server/server/src/types.ts`
- Modify: `hitl-mcp-server/server/src/ntfy-transport.ts`
- Modify: `hitl-mcp-server/server/src/mcp-server.ts`
- Modify: `hitl-mcp-server/server/src/__tests__/wire-compat.test.ts`
- Modify: `hitl-mcp-server/server/src/__tests__/ntfy-transport.test.ts`

**Interfaces:**
```ts
// types.ts — deliberately NOT part of HitlMessage
export interface SenderIdentityMessage {
  type: 'sender_identity';
  forMessageId: string;
  forType: 'question' | 'notification';
  sender: SenderIdentity; // from Task 2
}
```
```ts
// ntfy-transport.ts — sibling of publishPlan, same encrypt → assertNoChunk → publishRaw/uploadAttachment shape
async publishSenderIdentity(msg: SenderIdentityMessage, attachmentCipher?: string): Promise<void>;
```

- [ ] **Step 1: Write a failing `publishSenderIdentity` test**

  In `ntfy-transport.test.ts`, mirror the existing `publishPlan` tests: assert the encrypted/plaintext envelope shape, assert `assertNoChunk` rejects a pathological oversized `sender_identity` body rather than silently chunking it (same guard `publishPlan` has for `PlanMessage`), and assert the attachment-cipher branch calls `uploadAttachment`.

- [ ] **Step 2: Run RED**

  ```bash
  cd hitl-mcp-server/server
  npm test -- src/__tests__/ntfy-transport.test.ts
  ```
  Expected: `SenderIdentityMessage`/`publishSenderIdentity` do not exist.

- [ ] **Step 3: Implement the type and the sibling publish method**

  Add `SenderIdentityMessage` to `types.ts` (not added to the `HitlMessage` union). In `ntfy-transport.ts`, add `publishSenderIdentity` as a near-literal copy of `publishPlan`'s body, substituting `SenderIdentityMessage` for `PlanMessage`.

- [ ] **Step 4: Wire `AskUserQuestion` and `Notify` to publish it**

  In `mcp-server.ts`:
  - `AskUserQuestion` handler (around the existing `const repo = detectRepoContext();` line): after `await this.transport.publish(questionMsg)` succeeds, if `this.config.identityEnabled !== false`, call `resolveSenderIdentity(process.cwd(), this.config.deviceName)` and `await this.transport.publishSenderIdentity({ type: 'sender_identity', forMessageId: questionMsg.messageId, forType: 'question', sender })`. Do not let a publish failure here throw past the question flow — log and continue, per "decoration only."
  - `Notify` handler: same pattern after `await this.transport.publish(notification)`, with `forType: 'notification'` and `forMessageId: notification.messageId`. This is the first place a repo/identity concept touches `Notify` — it still never calls `detectRepoContext` (no `repo` field on `NotificationMessage`), it only resolves sender identity from `process.cwd()`.
  - Use a distinct local variable name for the resolved identity (e.g. `senderIdentity`) — `handleReviewPlan` already uses the name `identity` for the plan's own `{ planId, displayPath }` object; do not shadow it (relevant when Task 5 touches the same file).

- [ ] **Step 5: Add the wire-compat golden-byte proof**

  In `wire-compat.test.ts`, extend the existing "question construction" `describe` block (which already drives `AskUserQuestion` through the real SDK handler with `HITL_HOME` pointed at a temp dir):
  - With `identityEnabled` left at its default (`true`), assert the captured `bodies` array has **two** entries: the first is still byte-identical to `GOLDEN_QUESTION` (substituting the live `messageId`/`timestamp`/`repo` exactly as the existing test already does), and the second decodes to a `sender_identity` message whose `forMessageId` equals the question's `messageId`.
  - With `identityEnabled: false` in `CONFIG`, assert exactly **one** body is published and it is still byte-identical to `GOLDEN_QUESTION` — proving the frozen four are unchanged whether or not identity publishing is active.
  - Add an equivalent pair of assertions driving `Notify` against `GOLDEN_NOTIFICATION`.

- [ ] **Step 6: Run GREEN and full server tests**

  ```bash
  npm test -- src/__tests__/ntfy-transport.test.ts src/__tests__/wire-compat.test.ts
  npm test
  npx tsc --noEmit
  ```

- [ ] **Step 7: Commit**

  ```bash
  git add hitl-mcp-server/server/src/types.ts hitl-mcp-server/server/src/ntfy-transport.ts hitl-mcp-server/server/src/mcp-server.ts hitl-mcp-server/server/src/__tests__/wire-compat.test.ts hitl-mcp-server/server/src/__tests__/ntfy-transport.test.ts
  git commit -m "feat: publish sender identity alongside questions and notifications"
  ```

---

### Task 5: Carry sender identity on plan review messages

**Files:**
- Modify: `hitl-mcp-server/server/src/types.ts`
- Modify: `hitl-mcp-server/server/src/mcp-server.ts`
- Modify: `hitl-mcp-server/client/src-tauri/src/types.rs`
- Modify: `hitl-mcp-server/server/src/__tests__/wire-compat.test.ts` or `hitl-mcp-server/server/src/__tests__/review-payload.test.ts` (whichever already covers `PlanReviewMessage` construction)

**Interfaces:**
```ts
// types.ts
export interface PlanReviewMessage extends BaseMessage {
  // ...existing fields...
  sender?: SenderIdentity;
}
```
```rust
// types.rs
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SenderInfo {
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub source: String, // "session" | "worktree" | "path"
}

// PlanReviewMessage gains, alongside its other #[serde(default, ...)] fields:
#[serde(default, skip_serializing_if = "Option::is_none")]
pub sender: Option<SenderInfo>,
```

- [ ] **Step 1: Write a failing TS test that `ReviewPlan` attaches sender**

  Drive `handleReviewPlan` (or the existing test harness for it) the same way `wire-compat.test.ts`'s "question construction" block drives `AskUserQuestion`. Assert the published `plan_review` body includes a `sender` object resolved from `path.dirname(plan.resolvedPath)` — not `process.cwd()` — matching the existing `detectRepoContext(path.dirname(plan.resolvedPath))` call already used for this tool's `repo` field. Add a second case with `identityEnabled: false` asserting `sender` is entirely absent from the JSON (not `null` — omitted, since `sender?:` is optional).

- [ ] **Step 2: Run RED**

  ```bash
  cd hitl-mcp-server/server
  npm test -- src/__tests__/wire-compat.test.ts
  ```

- [ ] **Step 3: Implement the TS wiring**

  In `handleReviewPlan`, resolve `const senderIdentity = this.config.identityEnabled !== false ? resolveSenderIdentity(path.dirname(plan.resolvedPath), this.config.deviceName) : undefined;` and add `sender: senderIdentity,` to the `reviewMsg` object literal. Use `senderIdentity`, not `identity` — this file already has a local `identity` binding for `{ planId, displayPath }` a few lines above; reusing that name would silently shadow it.

- [ ] **Step 4: Run GREEN**

  ```bash
  npm test -- src/__tests__/wire-compat.test.ts
  npx tsc --noEmit
  ```

- [ ] **Step 5: Write a failing Rust tolerance test**

  In `types.rs`'s `#[cfg(test)] mod tests`, add `plan_review_deserializes_with_no_sender_field`, modeled directly on the existing `plan_review_deserializes_with_only_its_type` and `question_message_deserializes_when_sub_question_omits_question_field` tests: deserialize a `plan_review` JSON payload that has every other field populated but omits `sender` entirely, and assert it succeeds with `msg.sender.is_none()`. Add a second test deserializing a payload that *does* include `"sender":{"label":"Kay9 - work-item/1","source":"worktree"}` and assert the fields round-trip.

- [ ] **Step 6: Run RED**

  ```bash
  cd hitl-mcp-server/client/src-tauri
  cargo test plan_review_deserializes_with_no_sender_field -- --nocapture
  ```
  Expected: `sender` field/`SenderInfo` type do not exist on `PlanReviewMessage`.

- [ ] **Step 7: Implement the Rust mirror**

  Add `SenderInfo` and the `sender: Option<SenderInfo>` field to `PlanReviewMessage`, following the file's established "every field `#[serde(default)]`" tolerance convention (the block comment above the struct already explains why, citing past incidents) — do not make `sender` required.

- [ ] **Step 8: Run GREEN and full Rust suite**

  ```bash
  cargo test plan_review -- --nocapture
  cargo test
  ```

- [ ] **Step 9: Commit**

  ```bash
  git add hitl-mcp-server/server/src/types.ts hitl-mcp-server/server/src/mcp-server.ts hitl-mcp-server/client/src-tauri/src/types.rs hitl-mcp-server/server/src/__tests__/wire-compat.test.ts
  git commit -m "feat: carry sender identity on plan review messages"
  ```

---

### Task 6: Dispatch and cache sender identity in the Rust client

**Files:**
- Modify: `hitl-mcp-server/client/src-tauri/src/types.rs`
- Modify: `hitl-mcp-server/client/src-tauri/src/ntfy.rs`
- Modify: `hitl-mcp-server/client/src-tauri/src/main.rs`

**Interfaces:**
```rust
// types.rs
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SenderIdentityMessage {
    #[serde(default)]
    pub for_message_id: String,
    #[serde(default)]
    pub for_type: String,
    #[serde(default)]
    pub sender: SenderInfo, // reuse SenderInfo from Task 5
}
```
```rust
// ntfy.rs — small bounded FIFO cache, keyed→valued sibling of the existing
// presence-only `SeenIds` (VecDeque + HashSet, capacity 512). This one stores
// a value per key and uses a smaller capacity: one entry per not-yet-open
// dialog/notification window, not one per historically-seen message.
const SENDER_IDENTITY_CACHE_CAPACITY: usize = 128;

struct SenderIdentityCache {
    order: VecDeque<String>,
    entries: HashMap<String, SenderInfo>,
    capacity: usize,
}
impl SenderIdentityCache {
    fn with_capacity(capacity: usize) -> Self;
    /// FIFO-evicts the oldest entry when over capacity.
    fn insert(&mut self, for_message_id: &str, sender: SenderInfo);
    fn get(&self, for_message_id: &str) -> Option<SenderInfo>;
}
```

- [ ] **Step 1: Write failing cache unit tests**

  Inline `#[cfg(test)]` tests near `SenderIdentityCache` (same file/pattern as `SeenIds`'s own tests, if any — otherwise adjacent to the struct). Cover:
  - Insert then `get` returns the stored `SenderInfo`.
  - `get` for an unknown key returns `None` (no panic — this is the "unmatched identity is dropped" contract).
  - Inserting `capacity + 1` distinct keys evicts the oldest (FIFO), and a `get` for the evicted key returns `None`.
  - Re-inserting an existing key does not grow `order` past `capacity`.

- [ ] **Step 2: Run RED**

  ```bash
  cd hitl-mcp-server/client/src-tauri
  cargo test sender_identity_cache -- --nocapture
  ```

- [ ] **Step 3: Implement the cache**

  Same `VecDeque` + map FIFO shape as `SeenIds`, but `HashMap<String, SenderInfo>` instead of `HashSet<String>` since a value must be retrievable, not just a presence bit.

- [ ] **Step 4: Write failing dispatch-arm tests**

  Cover, at the `dispatch_message` level (or a small extracted pure helper, to keep this testable without a real `AppHandle`):
  - `sender_identity` for an *open* dialog window (`window_label("dialog", &msg.for_message_id)` resolves to a live window) → the window is emitted a `sender-identity` event with `{ forMessageId, sender }`; the cache is **not** populated for it.
  - `sender_identity` for a `for_type: "notification"` when the shared `"notifications"` window is open → same emit, targeting that fixed label.
  - `sender_identity` for a `forMessageId` with **no** open window → inserted into `SenderIdentityCache`, no emit, no error.
  - `sender_identity` with a malformed/empty `forMessageId` → dropped, no panic, no cache entry, no emit (mirrors the file's existing `Err(e) => log::error!(...)` pattern for other arms).

- [ ] **Step 5: Run RED**

  ```bash
  cargo test sender_identity -- --nocapture
  ```

- [ ] **Step 6: Implement the `"sender_identity"` dispatch arm**

  Add the arm alongside the existing `"question"`/`"plan_review_ack"`/`"plan_review"` arms in `dispatch_message`'s match on `env.msg_type.as_str()`. Parse `SenderIdentityMessage`; on parse failure, `log::error!` and drop, exactly like the other arms. On success:
  - Resolve the target window label from `for_type` (`window_label("dialog", &msg.for_message_id)` for `"question"`, the fixed `"notifications"` label for `"notification"`; an unrecognized `for_type` is dropped and logged).
  - If `app.get_webview_window(&label)` is `Some`, `window.emit("sender-identity", &json!({ "forMessageId": msg.for_message_id, "sender": msg.sender }))` and return.
  - Otherwise insert into the managed `SenderIdentityCache` (register it in `main.rs` via `.manage(...)`, mirroring `AckWaiters`/`OutstandingReviews`).

- [ ] **Step 7: Seed newly-created windows from the cache**

  In `show_question` (dialog windows) and `show_notification` (notification cards, added via the existing `add-notification` emit), before staging/emitting the payload, check `SenderIdentityCache::get` by the question's/notification's own `messageId`. If present, merge `sender` into the JSON object handed to the frontend — for `show_question` this means the object staged via `PayloadStore`/`take_window_payload`; for notifications it means merging into the `add-notification` event payload before it is emitted. This resolves the "window opens later and finds a matching cached entry" path without a second event: the frontend sees `sender` in its normal initial payload. The live "already open" path (Step 6) still uses the separate `sender-identity` patch event, since there is no "initial payload" left to mutate once a window already exists.

- [ ] **Step 8: Run GREEN and full Rust suite**

  ```bash
  cargo test sender_identity -- --nocapture
  cargo test
  ```

- [ ] **Step 9: Commit**

  ```bash
  git add hitl-mcp-server/client/src-tauri/src/types.rs hitl-mcp-server/client/src-tauri/src/ntfy.rs hitl-mcp-server/client/src-tauri/src/main.rs
  git commit -m "feat: dispatch and cache sender identity in Rust client"
  ```

---

### Task 7: Show the sender badge on the dialog window

**Files:**
- Modify: `hitl-mcp-server/client/src/dialog.js`
- Modify: `hitl-mcp-server/client/src/app.js`
- Modify: `hitl-mcp-server/client/src/styles.css`
- Modify: `hitl-mcp-server/client/tests/batch-stepper.spec.ts` (or a new `tests/dialog-badges.spec.ts` if the existing harness/spec doesn't cleanly extend)

**Interfaces:**
```js
// dialog.js — reusable by both initial render and the live-patch listener
export function renderSenderBadge(dialogContainer, sender); // sender: { label, source } | undefined
```

- [ ] **Step 1: Write failing Playwright tests**

  Using `test-harness.html`'s existing question-fixture mechanism, add a `sender: { label: 'Kay9 - work-item/1-reviewplan', source: 'worktree' }` field to a fixture and assert:
  - A `.badge-sender` element is visible in the initial viewport (no scrolling/expanding needed).
  - It sits inside `.meta-row`, a sibling of the repo/branch badges, and is **not** a descendant of `.context-section` (the collapsible block).
  - It carries a `title` attribute equal to the full, untruncated label, and its CSS truncates with ellipsis rather than wrapping/overflowing (assert `overflow: hidden` / `text-overflow: ellipsis` via computed style, or assert `scrollWidth > clientWidth` is tolerated without layout overflow using a long label).
  - A live-patch case: render a dialog with no `sender` on the initial fixture, then use a harness hook (`__simulateSenderIdentity(sender)`, mirroring `review-harness.html`'s existing `__simulateCompleted` hook pattern) to dispatch the same event `app.js` listens for, and assert the badge appears without a page reload.

- [ ] **Step 2: Run RED**

  ```bash
  cd hitl-mcp-server/client
  npx playwright test tests/batch-stepper.spec.ts -g "sender"
  ```
  Expected: `.badge-sender` never appears; harness hook missing.

- [ ] **Step 3: Implement `renderSenderBadge` and wire it into `renderDialog`**

  In `dialog.js`, extend the existing `metaBadges` string-building block (the same `if (repo) { metaBadges += ... }` pattern) with an `if (question.sender) { metaBadges += renderSenderBadge(question.sender); }` — reuse the same `<span class="badge">` shape with a new `badge-sender` class, and add a `title="${escapeHtml(sender.label)}"` attribute (no existing badge has this yet; introduce it here). Export a small update function so `app.js` can call it again after initial render for the live-patch case.

- [ ] **Step 4: Wire the live-patch listener in `app.js`**

  Alongside the existing `await listen('dismiss-question', ...)` call, add `await listen('sender-identity', (event) => { if (event.payload.forMessageId === currentQuestionId) { /* patch the badge into the already-rendered meta-row */ } })`.

- [ ] **Step 5: Add truncation CSS**

  In `styles.css`, extend the `.badge`/`.badge-icon` rules (no existing badge has truncation) with a `.badge-sender { max-width: ...; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }` rule.

- [ ] **Step 6: Run GREEN and the full dialog suite**

  ```bash
  npx playwright test tests/batch-stepper.spec.ts
  ```

- [ ] **Step 7: Commit**

  ```bash
  git add hitl-mcp-server/client/src/dialog.js hitl-mcp-server/client/src/app.js hitl-mcp-server/client/src/styles.css hitl-mcp-server/client/tests/batch-stepper.spec.ts
  git commit -m "feat: show sender badge on dialog window"
  ```

---

### Task 8: Show the sender badge on the review window

**Files:**
- Modify: `hitl-mcp-server/client/src/review.js`
- Modify: `hitl-mcp-server/client/src/review.css`
- Modify: `hitl-mcp-server/client/src/review-harness.html`
- Modify: `hitl-mcp-server/client/tests/review-window.spec.ts`

**Interfaces:**
- No Rust/event wiring needed — `sender` arrives inline on `PlanReviewMessage` (Task 5), so this is a pure rendering addition mirroring how `msg.repo`/`msg.isNewPlan` already populate `badges`.

- [ ] **Step 1: Write failing Playwright tests**

  In `review-window.spec.ts`, extend `planFixture(...)` (already used for the `repo` field) with a `sender: { label: 'Kay9 - work-item/1-reviewplan', source: 'worktree' }` case. Assert a `.badge-sender` inside `.review-badges` in the header (not inside the scrolling plan content), visible without expanding anything, truncating with `title` set to the full label. Add a second case with `sender` omitted asserting no `.badge-sender` renders (graceful absence, matching old-client tolerance).

- [ ] **Step 2: Run RED**

  ```bash
  cd hitl-mcp-server/client
  npx playwright test tests/review-window.spec.ts -g "sender"
  ```

- [ ] **Step 3: Implement the badge**

  In `review.js`, alongside the existing `badges.push(...)` lines for repo/branch/revision, add `if (msg.sender?.label) badges.push(`<span class="badge badge-sender" title="${escapeHtml(msg.sender.label)}">${escapeHtml(msg.sender.label)}</span>`);`.

- [ ] **Step 4: Add truncation CSS**

  In `review.css`, extend the `.badge` rules (currently no truncation on any badge here either) with `.badge-sender { max-width: ...; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }`, consistent with the class name/approach used in Task 7's `styles.css` change.

- [ ] **Step 5: Run GREEN and the full review-window suite**

  ```bash
  npx playwright test tests/review-window.spec.ts
  ```

- [ ] **Step 6: Commit**

  ```bash
  git add hitl-mcp-server/client/src/review.js hitl-mcp-server/client/src/review.css hitl-mcp-server/client/src/review-harness.html hitl-mcp-server/client/tests/review-window.spec.ts
  git commit -m "feat: show sender badge on review window"
  ```

---

### Task 9: Show the sender badge on the notification window

**Files:**
- Modify: `hitl-mcp-server/client/src/notifications.js`
- Modify: `hitl-mcp-server/client/src/notifications.css`
- Create: `hitl-mcp-server/client/src/notifications-harness.html` (or extend `test-notifications.html` if it can be made to `import` `notifications.js` as a module rather than duplicate its markup)
- Create: `hitl-mcp-server/client/tests/notifications.spec.ts`

**Interfaces:**
```js
// notifications.js
function applySenderIdentity(forMessageId, sender); // patches an already-rendered card's badge row
```

- [ ] **Step 1: Write a failing harness that imports `notifications.js` as a module**

  `notifications.html`/`test-notifications.html` currently hand-duplicate the card markup instead of importing `notifications.js`, which would let a badge implementation drift from its test. Build the new harness the way `review-harness.html` does — `import` the real module, expose minimal fixture-loading and `__simulateSenderIdentity` hooks — rather than reusing the duplicated `test-notifications.html`.

- [ ] **Step 2: Write failing Playwright tests in `tests/notifications.spec.ts`**

  Cover:
  - A notification whose `add-notification` payload already includes `sender` (the cache-hit-before-render path from Task 6, Step 7) → `.badge-sender` visible in the card's `.notification-header` immediately, not nested inside `.notification-context`/`.notification-body`.
  - A notification rendered with no `sender`, followed by a simulated `sender-identity` event for its `messageId` (the live-patch path) → badge appears afterward without re-rendering the whole card.
  - Truncation: a long label truncates with ellipsis and a `title` attribute holds the full text.
  - A `sender-identity` event for a `forMessageId` that does not match any rendered card → no error, no orphan badge anywhere.

- [ ] **Step 3: Run RED**

  ```bash
  cd hitl-mcp-server/client
  npx playwright test tests/notifications.spec.ts
  ```
  Expected: no badge row exists; harness/spec scaffolding is new.

- [ ] **Step 4: Implement the badge row and `applySenderIdentity`**

  In `notifications.js`'s `addNotificationCard`, add a conditional badge row into `.notification-header` (or immediately below it) when `notification.sender` is present, following the same `<span class="badge badge-sender" title="...">` shape used in Tasks 7/8. Implement `applySenderIdentity(forMessageId, sender)`: find the card via `listEl.querySelector('[data-id="..."]')` and insert/update its badge row if the card exists; no-op (not an error) if it doesn't. Wire a new `listen('sender-identity', ...)` alongside the existing `listen('add-notification', ...)`/`listen('remove-notification', ...)` calls in `setupListeners`.

- [ ] **Step 5: Add badge CSS**

  `notifications.css` has no `.badge` class today (it is fully self-contained, no shared import with `styles.css`/`review.css`). Add a `.badge`/`.badge-sender` block here matching the same visual language (pill shape, muted background) as Tasks 7/8's badges, plus the truncation rule.

- [ ] **Step 6: Run GREEN**

  ```bash
  npx playwright test tests/notifications.spec.ts
  npx playwright test tests/review-security.spec.ts
  ```
  The second command re-runs the existing smoke test that loads `notifications.html`/`test-notifications.html` and asserts no console errors, guarding against the harness/markup changes breaking that page-load check.

- [ ] **Step 7: Commit**

  ```bash
  git add hitl-mcp-server/client/src/notifications.js hitl-mcp-server/client/src/notifications.css hitl-mcp-server/client/src/notifications-harness.html hitl-mcp-server/client/tests/notifications.spec.ts
  git commit -m "feat: show sender badge on notification window"
  ```

---

### Task 10: Final sender-identity verification

**Files:** No production changes expected.

- [ ] **Step 1: Run every automated suite**

  ```bash
  cd hitl-mcp-server/server && npm test && npx tsc --noEmit && npm run build
  cd ../client/src-tauri && cargo test
  cd ../../client && npx playwright test
  ```
  Expected: zero failures, zero TypeScript errors, zero build warnings introduced by this change.

- [ ] **Step 2: Run mutation checks**

  - In `config.ts`, temporarily change `identityEnabled: parsed.identityEnabled !== false` to `identityEnabled: parsed.identityEnabled || true` (the defeated-opt-out idiom the design explicitly rejects); confirm the `identityEnabled: false` config test fails. Revert.
  - In `git-context.ts`, temporarily make `isLinkedWorktree` always return `false`; confirm the worktree-tier resolver test fails and the plan-review-window worktree-badge test fails. Revert.
  - In `ntfy.rs`, temporarily make the `SenderIdentityCache` capacity effectively unbounded (or skip eviction); confirm the FIFO-eviction cache test fails. Revert. Then temporarily make `dispatch_message`'s `"sender_identity"` arm always emit even when no window is open (skip the `get_webview_window` check); confirm no test crashes but re-verify by hand that this would silently drop the "unmatched identity dropped, no error" guarantee — this should surface as a design smell, not a passing test, so also check no test was accidentally asserting the wrong thing. Revert.
  - In `wire-compat.test.ts`'s new assertions, temporarily allow a `sender_identity` publish to alter `GOLDEN_QUESTION` bytes (e.g. comment out the "still one body when disabled" assertion); confirm the golden-byte-with-identity-disabled test would have caught a real regression. Revert.

- [ ] **Step 3: Verify with two real clients**

  Start two clients on the same topic with different `deviceName`s, one `cwd`'d into a linked worktree. Ask a question, send a notification, and open a plan review from each device. Confirm each surface shows the sender badge outside any collapsible section on the peer device, truncates a long branch name with a hover tooltip, and that setting `identityEnabled: false` on one device stops its outgoing badges from appearing on the other while it still sees the other device's badges normally.

- [ ] **Step 4: Check repository hygiene**

  ```bash
  git status --short
  ```
  Commit only if verification required legitimate tracked test corrections; do not commit runtime artifacts (temp git repos, Playwright report output, etc).
