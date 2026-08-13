# Legacy Message Attachment Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move oversized legacy messages toward attachment transport while preserving frozen wire shapes, old clients, old servers, and cached chunk traffic.

**Architecture:** Introduce a protocol-v2 `large_message` carrier for the four legacy inner message types. Phase A dual-publishes the carrier and existing chunks. New clients prefer a successfully decoded carrier and suppress matching chunk fallback by original `messageId`; carrier failure leaves chunks usable. Plan-family attachment transport remains unchanged.

**Tech Stack:** TypeScript/Node.js, Rust/Tauri, gzip, AES-256-GCM, ntfy attachments, Jest, Cargo tests.

## Global Constraints

- `question`, `answer`, `notification`, and `dismiss_notification` stay byte-for-byte compatible when small and never gain `protocolVersion`.
- `large_message` applies only to those four types, never to the plan family.
- Attachment URL is ntfy event metadata and is never serialized inside `large_message`.
- Content hash covers `base64(gzip(JSON))`, matching existing payload semantics.
- Decompressed-size enforcement remains a separate safety check.
- Phase A publishes attachment carrier plus chunks; chunk decoding remains.
- Carrier decode failure must not suppress chunk fallback.
- Phase B fallback is a deployment-level setting and is not enabled by default until its own release task.

---

### Task 1: Define and encode the large-message carrier

**Files:**
- Modify: `hitl-mcp-server/server/src/types.ts`
- Create: `hitl-mcp-server/server/src/large-message.ts`
- Test: `hitl-mcp-server/server/src/__tests__/large-message.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface LargeMessage extends BaseMessage {
    type: 'large_message';
    protocolVersion: 2;
    originalMessageId: string;
    innerType: HitlMessage['type'];
    payloadRef: { contentHash: string; contentLength: number };
  }
  export interface EncodedLargeMessage { cipher: string; contentHash: string; contentLength: number }
  export function encodeLargeMessage(inner: HitlMessage, keyHex?: string): EncodedLargeMessage;
  export function decodeLargeMessage(cipher: string, keyHex: string | undefined, expectedHash: string): HitlMessage;
  ```

- [ ] **Step 1: Write failing round-trip tests**

  Test plain and encrypted question round trips. Assert `contentHash` is SHA-256 of the plaintext string `base64(gzip(JSON.stringify(inner)))`, not the decompressed JSON and not the encrypted envelope.

- [ ] **Step 2: Run RED**

  ```bash
  cd hitl-mcp-server/server
  npm test -- --runInBand src/__tests__/large-message.test.ts
  ```
  Expected: module and type do not exist.

- [ ] **Step 3: Implement minimal encoding and decoding**

  Reuse the existing crypto helpers and payload size constants/patterns. Gzip JSON, base64 it, hash that plaintext string, optionally encrypt it, and return length of cipher bytes. Decode in the reverse order, verify hash before gunzip, enforce decompressed max output, then validate that the parsed inner type is one of the frozen four.

- [ ] **Step 4: Add failing error taxonomy tests**

  Cover wrong key, hash mismatch, corrupt gzip/JSON, unsupported inner type, compressed cap, and decompressed cap. Use typed errors with stable `kind` values.

- [ ] **Step 5: Implement errors and caps**

  Do not duplicate plan-family semantics accidentally; import shared constants only where their limits are intentionally equal and add comments that any equality is enforced by tests rather than assumed.

- [ ] **Step 6: Run GREEN and type-check**

  ```bash
  npm test -- --runInBand src/__tests__/large-message.test.ts
  npx tsc --noEmit
  ```

- [ ] **Step 7: Commit**

  ```bash
  git add hitl-mcp-server/server/src/types.ts hitl-mcp-server/server/src/large-message.ts hitl-mcp-server/server/src/__tests__/large-message.test.ts
  git commit -m "feat: encode oversized legacy message carriers"
  ```

---

### Task 2: Dual-publish carrier and chunk fallback

**Files:**
- Modify: `hitl-mcp-server/server/src/ntfy-transport.ts`
- Modify: `hitl-mcp-server/server/src/__tests__/wire-compat.test.ts`
- Modify: `hitl-mcp-server/server/src/__tests__/ntfy-transport.test.ts`

**Interfaces:**
- Consumes: `encodeLargeMessage` and `LargeMessage` from Task 1.
- Produces: oversized publish sequence: attachment upload/carrier event, then existing chunks.

- [ ] **Step 1: Write failing dual-publish test**

  Publish an incompressible oversized `QuestionMessage`. Capture ntfy requests. Assert one `large_message` outer message with `protocolVersion: 2`, matching `originalMessageId`, `innerType`, and payload hash/length metadata; assert attachment PUT occurred; assert chunk fallback still uses the original group ID.

- [ ] **Step 2: Run RED**

  ```bash
  npm test -- --runInBand src/__tests__/wire-compat.test.ts
  ```

- [ ] **Step 3: Implement Phase A publishing**

  Keep small-message `publish()` unchanged. For an oversized body, call a new private carrier publisher that mirrors `publishPlan`: serialize and optionally encrypt the `LargeMessage` outer envelope, then call the existing attachment PUT once with the cipher as its body and the outer envelope in `X-Message`. That single PUT creates the ntfy event; there is no separate outer POST and no attachment URL in our envelope. Generalize attachment-helper log/error text that currently says “plan” so it accurately covers both plan and legacy carriers. After the carrier PUT, publish existing chunks.

- [ ] **Step 4: Add failure-order tests**

  Test carrier upload failure. During Phase A, chunks must still publish. The carrier failure must be logged/returned through an explicit diagnostic hook; do not silently claim full dual delivery. Test chunk fallback failure separately and report that the attachment carrier was still published.

- [ ] **Step 5: Preserve golden legacy bytes**

  Run all existing golden tests unchanged. Add an assertion that small legacy messages still produce exactly one legacy body with no `protocolVersion`.

- [ ] **Step 6: Run GREEN and full server tests**

  ```bash
  npm test -- --runInBand src/__tests__/wire-compat.test.ts src/__tests__/ntfy-transport.test.ts
  npm test -- --runInBand
  ```

- [ ] **Step 7: Commit**

  ```bash
  git add hitl-mcp-server/server/src/ntfy-transport.ts hitl-mcp-server/server/src/__tests__/wire-compat.test.ts hitl-mcp-server/server/src/__tests__/ntfy-transport.test.ts
  git commit -m "feat: dual-publish oversized legacy attachments"
  ```

---

### Task 3: Add cross-language carrier fixtures

**Files:**
- Create: `hitl-mcp-server/server/scripts/gen-large-message-fixture.ts`
- Modify: `hitl-mcp-server/server/package.json`
- Create: `hitl-mcp-server/fixtures/large-message-payload.json`
- Test: `hitl-mcp-server/server/src/__tests__/large-message.test.ts`

- [ ] **Step 1: Write a failing fixture stability test**

  Assert the checked-in fixture has cases for all four inner types, plain and encrypted, with content hash and length.

- [ ] **Step 2: Run RED**

  Expected: fixture absent.

- [ ] **Step 3: Implement deterministic generator**

  Follow the existing plan payload fixture generator. Use fixed key/material where needed so generated bytes are reproducible; if crypto uses random IVs, inject fixed fixture values through the same tested hook rather than normal production paths.

- [ ] **Step 4: Generate and verify**

  ```bash
  npm run fixture:large-message
  npm test -- --runInBand src/__tests__/large-message.test.ts
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add hitl-mcp-server/server/scripts/gen-large-message-fixture.ts hitl-mcp-server/server/package.json hitl-mcp-server/fixtures/large-message-payload.json hitl-mcp-server/server/src/__tests__/large-message.test.ts
  git commit -m "test: add cross-language large message fixtures"
  ```

---

### Task 4: Decode the carrier in Rust

**Files:**
- Modify: `hitl-mcp-server/client/src-tauri/src/types.rs`
- Create: `hitl-mcp-server/client/src-tauri/src/large_message.rs`
- Modify: `hitl-mcp-server/client/src-tauri/src/main.rs`
- Test: inline Rust tests in `large_message.rs`

**Interfaces:**
- `LargeMessage` contains no attachment URL.
- Decoder consumes cipher bytes downloaded from the raw ntfy event attachment plus `payload_ref.content_hash`.

- [ ] **Step 1: Write failing fixture decode tests**

  Load every TypeScript-generated case. Assert exact inner JSON/types for plain and encrypted fixtures.

- [ ] **Step 2: Run RED**

  ```bash
  cd hitl-mcp-server/client/src-tauri
  cargo test large_message -- --nocapture
  ```

- [ ] **Step 3: Implement types and decoder**

  Mirror camelCase fields and optional protocol version conventions. Decrypt when required, hash the base64-gzip plaintext, verify hash, decode base64, gunzip with output cap, parse and validate one frozen legacy type.

- [ ] **Step 4: Add failing taxonomy tests**

  Cover expired/missing attachment mapping, wrong key, hash mismatch, corrupt gzip/JSON, and decompressed cap. Keep stable `kind()` strings for future Phase B UI.

- [ ] **Step 5: Implement errors and run GREEN**

  ```bash
  cargo test large_message -- --nocapture
  cargo test
  ```

- [ ] **Step 6: Commit**

  ```bash
  git add hitl-mcp-server/client/src-tauri/src/types.rs hitl-mcp-server/client/src-tauri/src/large_message.rs hitl-mcp-server/client/src-tauri/src/main.rs
  git commit -m "feat: decode large legacy message attachments"
  ```

---

### Task 5: Dispatch carriers and deduplicate chunk fallback

**Files:**
- Modify: `hitl-mcp-server/client/src-tauri/src/ntfy.rs`
- Test: inline Rust tests in `ntfy.rs`
- Verify unchanged: `hitl-mcp-server/client/src-tauri/src/chunking.rs`

**Interfaces:**
- Add bounded state tracking original IDs successfully resolved by carrier.
- Record success only after download, integrity check, decode, and inner dispatch preparation succeed.

- [ ] **Step 1: Write failing dedup tests**

  Cover:
  - Carrier success then chunks → dispatch once.
  - Chunks then carrier → dispatch once.
  - Carrier missing/failing then chunks → chunks dispatch.
  - Chunks from an old server with no carrier → dispatch unchanged.
  - All four inner legacy types re-enter existing handlers.

- [ ] **Step 2: Run RED**

  ```bash
  cargo test large_message -- --nocapture
  cargo test carrier -- --nocapture
  ```

- [ ] **Step 3: Implement dispatch**

  Add a `large_message` envelope arm. Read `AttachmentRef` from the raw ntfy event parameter, not the application message. Download/decode, then route recovered inner JSON through existing legacy dispatch. Track resolved original IDs in a bounded FIFO set. In chunk completion, suppress only when the carrier was successfully resolved.

- [ ] **Step 4: Preserve cache/live behavior**

  Use the same dedup state across cache replay and live subscription. Do not remove or weaken `ChunkAssembler`; run its existing tests unchanged.

- [ ] **Step 5: Run GREEN and full Rust suite**

  ```bash
  cargo test carrier -- --nocapture
  cargo test chunking -- --nocapture
  cargo test
  ```

- [ ] **Step 6: Commit**

  ```bash
  git add hitl-mcp-server/client/src-tauri/src/ntfy.rs
  git commit -m "feat: prefer large message attachments over chunks"
  ```

---

### Task 6: Document Phase B configuration without flipping production defaults

**Files:**
- Modify: `hitl-mcp-server/README.md`
- Modify: `docs/superpowers/specs/2026-08-12-review-lifecycle-attachment-migration-design.md` only if implementation discovered a factual correction.

- [ ] **Step 1: Document shipping Phase A**

  State that oversized legacy messages are dual-published, new clients prefer attachment carriers, old clients use chunks, and chunk decoding remains required.

- [ ] **Step 2: Document future Phase B flag contract**

  Name the deployment-level flag `legacyChunkFallback`. State that Phase A behavior remains the current default; a later release will make carrier-only default while allowing explicit fallback. Do not add the config field yet unless Phase B is being implemented in the same release.

- [ ] **Step 3: Document expiry behavior**

  During Phase A, failed/expired carriers fall back to chunks. Phase B must surface resend-required state before fallback is disabled.

- [ ] **Step 4: Commit**

  ```bash
  git add hitl-mcp-server/README.md docs/superpowers/specs/2026-08-12-review-lifecycle-attachment-migration-design.md
  git commit -m "docs: explain phased legacy attachment migration"
  ```

---

### Task 7: Final attachment migration verification

**Files:** No production changes expected.

- [ ] **Step 1: Run complete automated suites**

  ```bash
  cd hitl-mcp-server/server && npm test -- --runInBand && npx tsc --noEmit && npm run build
  cd ../client/src-tauri && cargo test
  cd ../../ && npx playwright test
  ```

- [ ] **Step 2: Mutation-check fallback safety**

  Temporarily mark an original ID resolved when the carrier merely arrives; confirm the carrier-failure/chunk-fallback test fails. Revert. Temporarily remove chunk dual-publish; confirm old-client compatibility test fails. Revert.

- [ ] **Step 3: Live Phase A verification**

  With attachment-enabled ntfy, send oversized question, answer, notification, and dismiss messages. Confirm a current client renders each once. Confirm logs show carrier and chunk fallback publication. Run an older client and confirm it receives the chunk path.

- [ ] **Step 4: Live expiry fallback verification**

  Force carrier download failure or expiry while chunks remain available. Confirm the current client still renders from chunks and records the carrier failure without showing a false resend-required error during Phase A.

- [ ] **Step 5: Check repository hygiene**

  ```bash
  git status --short
  ```
  Remove only generated artifacts created by this verification. Do not delete unrelated untracked files.
