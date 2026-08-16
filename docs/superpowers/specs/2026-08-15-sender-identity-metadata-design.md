# Sender identity metadata design

## Context

A user running HITL across several machines and agent sessions cannot tell, without expanding anything, which machine or agent sent a given question, notification, or plan review. Dialogs, notification windows, and review windows currently show repo/branch context but nothing that distinguishes "Kay9 on worktree A" from "Kay9 on worktree B" or from a second laptop on the same ntfy topic. This design adds an always-visible sender label to all three surfaces without touching the four byte-frozen legacy wire shapes.

## Decisions

- Every question, notification, and plan review carries a resolvable sender identity, shown as an always-visible badge outside any collapsible section.
- Machine name is `config.deviceName` (already defaults to `os.hostname()`); nothing new to resolve there.
- Identity resolution adds a worktree tier and a path-fallback tier on top of the existing machine name, plus an optional session-name override.
- The four legacy wire types (`question`, `answer`, `notification`, `dismiss_notification`) are never modified: no new fields, no `protocolVersion`. Sender identity for these travels as a separate, encrypted companion message.
- `PlanReviewMessage` gets a direct `sender` field, since it already carries `protocolVersion: 2` (`PROTOCOL_VERSION` in `hitl-mcp-server/server/src/types.ts`).
- Identity is decoration only. Nothing in the question/answer or review lifecycle waits on it, retries for it, or fails without it.
- Identity content stays inside the existing encrypted envelope. It is never placed in a plaintext ntfy header and never contains an absolute path (F-9, same rule already applied to `AttachmentRef.name` and `displayPath` in `types.ts`).
- A new `identityEnabled` config flag (default `true`) in `~/.hitl/config.json` lets a user opt out of publishing their own identity.

## Identity label resolution

Label is computed per outgoing message, using the same cwd the tool already resolves for repo context — no new cwd concept is introduced:

- `AskUserQuestion` and `Notify`: `process.cwd()` (matches the existing bare `detectRepoContext()` call in `mcp-server.ts`).
- `ReviewPlan`: `path.dirname(plan.resolvedPath)` (matches the existing `detectRepoContext(path.dirname(plan.resolvedPath))` call used for the review's `repo` field).

Resolution order, highest precedence first:

1. **Session name.** If a session-name resolver returns a non-null value, use it verbatim as the label. Implemented today as a pluggable resolver that always returns `null` — no documented Claude Code environment variable exposes a human-readable session name, only a UUID, and this design does not invent one. The seam exists so a real resolver can be dropped in later without touching call sites.
2. **Linked worktree.** If the cwd is a linked git worktree, label is `<machine> - <worktree branch>`, e.g. `Kay9 - work-item/1-reviewplan`. Machine is `config.deviceName`; branch comes from the same git-branch idiom `git-context.ts` already uses (spawn `git`, parse trimmed stdout).
3. **Otherwise.** Label is `<machine>` plus the last two path segments of the working directory, forward-slash joined, e.g. `Kay9 hitl-mcp-server/server`. Never an absolute path (F-9) — only the trailing two segments are used, regardless of platform path separator.

Worktree detection: compare `git rev-parse --git-dir` against `git rev-parse --git-common-dir` for the resolved cwd. They differ in a linked worktree and match in the main working tree or a non-worktree repo. This is a new export alongside `detectRepoContext`/`resolveRepoRoot` in `git-context.ts`, following that file's existing idiom (spawn git, trim stdout, tolerate non-git directories by falling back to tier 3).

## Wire format

### Companion message for questions and notifications

A new encrypted message type, `sender_identity`, is added. It is **not** part of the `HitlMessage` union (`QuestionMessage | AnswerMessage | NotificationMessage | DismissNotificationMessage`) so the union and its four frozen shapes are untouched. Shape:

```ts
interface SenderIdentityMessage {
  type: 'sender_identity';
  forMessageId: string;   // the question/notification messageId this decorates
  forType: 'question' | 'notification';
  sender: {
    label: string;        // resolved display label
    source: 'session' | 'worktree' | 'path'; // which resolution tier produced it
  };
}
```

Published through a sibling method mirroring `publishPlan` (`ntfy-transport.ts`) — same encrypt-then-`publishRaw`/`uploadAttachment` shape, same size-limit and chunk-avoidance handling — but for `sender_identity` payloads instead of `PlanMessage`. It is sent once, right after the question or notification it decorates.

### Direct field for plan review

`PlanReviewMessage` (`types.ts`) gains a `sender` field of the same `{ label, source }` shape, sent inline since the message already carries `protocolVersion: 2`. No wire-shape migration is needed here — protocol v2 clients already tolerate new optional fields on this family.

### Compatibility and ordering

- Old clients that don't know `sender_identity` ignore it (unknown message type on the wire) and simply render no badge — same graceful-degradation behavior old clients already show for other new message types.
- Old clients that don't know `PlanReviewMessage.sender` ignore the extra field; Rust-side deserialization uses the same `#[serde(default)]`-per-field tolerance already established for `DialogOption.value` and `SubQuestion.question` in `client/src-tauri/src/types.rs`, so a `plan_review` payload missing `sender` still deserializes.
- Delivery order between a question/notification and its `sender_identity` companion is not guaranteed. Each client keeps a small bounded cache keyed by `forMessageId`:
  - If the target window is already open when `sender_identity` arrives, patch its badge row in place.
  - If the window opens later and finds a matching cached entry, render the badge immediately instead of the "no badge" default.
  - A `sender_identity` that never finds a match (window already closed, or cache evicted) is simply dropped — it never blocks, retries, or surfaces an error.

## Privacy and configuration

- Identity data (label, source) only ever travels inside the message body that already goes through `encrypt()`/`X-Message`. It is never added as a new ntfy HTTP header — the only header ntfy attachments already set in plaintext is `Filename` (random hex, per the existing F-9 comment in `ntfy-transport.ts`), and this design adds nothing beside it.
- Labels never contain an absolute path (F-9): the path-fallback tier truncates to the last two segments before it is ever serialized.
- `HitlConfig` gains `identityEnabled?: boolean` (default `true` when absent), read the same way `deviceName` is defaulted today in `config.ts`. When `false`, the sending client stops publishing `sender_identity` and stops populating `PlanReviewMessage.sender`; it does not affect whether that client displays badges for *other* senders' identity.

## UI

Always-visible badge row, placed outside any collapsible section, in all three windows:

- **Dialog window** (`client/src/dialog.js`): extend the existing `meta-row` badge pattern (currently repo name/branch) that already renders above the collapsible `.context-section` — add a sender badge to the same row, same precedent already used for repo/branch badges.
- **Review window** (`client/src/review.js`): extend the existing `review-badges` span in the window header (currently repo/branch/revision badges) with a sender badge.
- **Notification window** (`client/src/notifications.html`): has no badge row today beyond the unrelated `count-badge`. This design adds a new badge row plus its CSS, following the same visual treatment as the dialog/review badges.

Badge text must truncate gracefully (ellipsis, `title` attribute for full text on hover) rather than wrap or push out layout, since worktree branch names and path segments are unbounded in length.

## Non-goals

- No authentication or spoofing protection — identity is advisory decoration, not a verified claim.
- No implementation of a real session-name resolver in this change; only the pluggable seam that returns `null`.
- No persistence of sender identity into review snapshot/revision history (`snapshot-store.ts`) — only the live message carries it.
- No changes to the four legacy wire shapes, `protocolVersion` semantics, or existing chunk/attachment migration work.
- No i18n/localization of badge text.
- No cross-device identity deduplication or "who else is viewing this" presence feature.

## Open questions

- Exact size/TTL bound for the `forMessageId` sender-identity cache used to patch already-open or soon-to-open windows.
- Whether `identityEnabled: false` on the *receiving* client should hide inbound badges too, or only suppress outbound publishing (current design assumes the latter).
- Whether a `sender_identity` should be re-published if `deviceName` changes mid-session, or the label is fixed at send time.
- Character/width budget for badge truncation across the three window types, which differ in layout width.

## Verification

- Resolver unit tests: linked worktree, non-worktree repo, non-git directory (path fallback), and session-name precedence over both.
- Wire-compat golden-byte test proving the four legacy message shapes are byte-identical whether or not `sender_identity` publishing is enabled.
- Rust deserialization tolerance tests, including a `plan_review` payload with no `sender` field.
- Playwright assertions that the sender badge is visible in the initial viewport and not nested inside any collapsible/expandable element, across dialog, notification, and review windows.
