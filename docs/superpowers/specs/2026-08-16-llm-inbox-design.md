# LLM Inbox — Design

**Date:** 2026-08-16
**Status:** Draft for review
**Author:** design session with Gautam Bhakar

---

## 1. Problem

Agents running in many Claude Code sessions each send messages through the HITL MCP
server — questions, notifications, plan reviews. Today each message opens an ephemeral
popup window and then vanishes. There is:

- no single place to see messages from all agents,
- no record of what was asked or what was answered,
- no way to tell, at a glance, which requests are still waiting on you.

The LLM Inbox is a 3-pane application that fixes all three.

## 2. Goals

1. One place to see every message from every agent, live.
2. A durable record of what was replied to, by whom, from which device.
3. Reply to questions and plan reviews directly from the Inbox.
4. When any client replies, every other client reflects it immediately.
5. Run on desktop now; run on phone/tablet later without re-architecting.

### Non-goals (v1)

- Replacing the existing popup windows. They stay.
- Multi-user. This is one person's agents on one person's devices.
- Search/analytics beyond filtering by agent and status.
- Changing the wire protocol or bumping `protocolVersion`.

---

## 3. What already exists

Established by codebase research, not assumption. Details in
`scratchpad/conversation_memories/llm-inbox-design/`.

| Layer | Reality |
|---|---|
| Transport | **ntfy.sh pub/sub, one shared topic**, AES-256-GCM. No HTTP server, no port, no WebSocket. |
| Auth | The `topicId` **is** the shared secret. `encryptionKey` is a 64-hex AES key. Both in `~/.hitl/config.json`. |
| MCP server | `@achieveai/hitl-mcp-server`, stdio only. Publishes to ntfy, subscribes for replies. |
| Client | **Tauri v2 desktop app already exists.** Rust `ntfy.rs` (2704 lines) + vanilla-JS webviews. Three ephemeral windows. |
| History | **None.** Only `~/.hitl/plans/` (plan bodies) and `pending/<pid>.json` (crash resume, deleted on resolve). |
| Retention | ntfy.sh defaults: messages **12h**, attachments **3h**. **This deployment is self-hosted** (`ntfyUrl: https://local-gb.mcqdb.com/ntfy/`), so both are configurable via the server's `cache-duration` / `attachment-expiry-duration`. See §11.1 — this materially changes the archivist's role. |
| Mobile | Marketed in the README, **not implemented**. No Android/iOS target scaffolded. |

> **Note:** the root `CLAUDE.md` and `README.md` describe an Express dialog server on an
> auto-assigned port. That is **dead v1 code** (`hitl-mcp-server/src/`), not in the npm
> workspaces and not published. Those docs are stale and should be corrected separately.

### 3.1 The key insight

**The ntfy topic is already a complete, ordered event log of every message from every
agent** — questions, answers, notifications, dismissals, plan reviews, verdicts,
acknowledgements, cancellations. It is already fanned out to every device.

The Inbox does not need a new pipeline. It needs to subscribe to the one that exists,
and remember what it sees.

---

## 4. Architecture

```
  N Claude Code sessions
  ┌──────┐ ┌──────┐ ┌──────┐
  │ MCP  │ │ MCP  │ │ MCP  │   each: stdio to its host,
  │ srv  │ │ srv  │ │ srv  │   HTTPS publisher to ntfy
  └───┬──┘ └───┬──┘ └───┬──┘
      └────────┼────────┘
               ▼
    ╔═══════════════════════╗
    ║   ntfy topic          ║   append-only event log
    ║   AES-256-GCM         ║   totally ordered, fanned out, 12h retention
    ╚═══════════════════════╝
       │        │        │
       ▼        ▼        ▼
  ┌─────────┐ ┌───────────┐ ┌──────────┐
  │archivist│ │hitl-client│ │hitl-inbox│  ← NEW
  │always-on│ │ (popups)  │ │ (3-pane) │
  │ full    │ └───────────┘ └──────────┘
  │ history │        └─── crates/hitl-transport ───┘
  └────┬────┘                    (NEW shared crate)
       └── backfill ──────────────────┘
```

### 4.1 Components

| Component | What it is | Status |
|---|---|---|
| `crates/hitl-transport` | Rust crate: ntfy subscribe/publish, AES-GCM envelope, chunk reassembly, attachment fetch, replay, dedup, typed message enums, **and the fold** | **New** — extracted from `client/src-tauri/src/ntfy.rs` |
| `hitl-inbox` | The 3-pane app. Local SQLite projection + UI | **New** |
| `archivist` | Headless. Subscribes 24/7, appends every event forever, serves backfill | **New** |
| `hitl-client` | Existing popup windows | **Refactored** to consume the crate |

### 4.2 The governing rule

**Status is never stored. It is folded.**

```
status(messageId) = fold(all events whose subject is messageId, in ntfy order)
```

A question is `pending` because no `answer` event exists yet. It becomes `answered` the
instant an `answer` event lands — from *any* device. Every subscriber folds the same
events and reaches the same conclusion, independently, with no coordination.

This is what satisfies Goal 4. "Any application replies, all applications update" is not
a feature that gets built; it is a property obtained by refusing to store mutable state.

### 4.3 Why a total order exists

ntfy assigns every message an id and delivers messages to all subscribers in the same
order. That is a **total order observed identically by every client**. Two clients
folding the same event set therefore always agree — including on who won a race.

The Inbox uses ntfy's own message id/time as the ordering authority, never local
wall-clock time, and never the `timestamp` field inside the payload (which is set by
whichever machine composed the message and is not comparable across devices).

### 4.4 Extracting the transport crate

`ntfy.rs` is 2704 lines, but only part of it is transport. The split:

| Moves to `hitl-transport` | Stays in `hitl-client` |
|---|---|
| subscribe loop, backoff, resume-from-`since` | `show_question` / `show_notification` / `show_review` |
| AES-GCM encrypt/decrypt (`crypto.rs`) | window sizing, monitor fitting, always-on-top |
| chunk reassembly (`chunking.rs`) | `PayloadStore` / `take_window_payload` |
| attachment upload/fetch (`payload.rs`) | tray, sound, drafts |
| `SeenIds` dedup, cache replay | sender-badge live-patch DOM logic |
| message type enums (`types.rs`) | `version_verdict()` UI gating |
| **the fold** (new code) | |

Window management is roughly 60% of the file and does not move. This is a lift, not a
rewrite. It is also the precondition for mobile, which needs the transport without any
desktop window code.

**Risk control:** the refactor must be behaviour-preserving. The existing Playwright
suite (`client/tests/*.spec.ts`) plus the server Jest suite are the regression gate. The
crate lands and `hitl-client` is cut over **before** any Inbox code is written.

### 4.5 Two subscribers

`hitl-client` and `hitl-inbox` both subscribe to the same topic. For reading this is
harmless — both fold the same log and converge.

For writing, see §8. The short version: from the log's perspective a second app on the
same machine is indistinguishable from your phone. The race already existed; the
standalone split does not create it.

**Auto-launch caveat:** the MCP server calls `requireClient()` → `ensureClientRunning()`
before every publish, because publishing to a topic with no subscriber would hang
forever. That logic keeps launching `hitl-client` only. The Inbox is launched by the
user (or by OS login items) and is never required for correctness.

---

## 5. Agent identity

### 5.1 The problem

`QuestionMessage` and `NotificationMessage` carry **no** agent or session id. Only:

- `messageId` — unique per message, useless for grouping
- `repo: RepoContext { name, branch, remoteUrl }` — collides for two sessions on one branch
- a **separate, droppable** `sender_identity` message correlated by `forMessageId`

`SenderIdentitySource` is `'session' | 'worktree' | 'path'`. The `'session'` tier is
already the highest precedence in `resolveSenderIdentity()` (`identity.ts:29-45`) but is
dead: `defaultSessionNameResolver` (`identity.ts:12`) is a stub returning `null`.

### 5.2 Claude Code exposes no session id — confirmed

Open issue [anthropics/claude-code#41836](https://github.com/anthropics/claude-code/issues/41836).

| Var | Stable? | Verdict |
|---|---|---|
| `CLAUDE_PROJECT_DIR` | **Yes** — documented, unchanged by `--resume`/compaction | **Use as the project key** |
| `CLAUDECODE=1` | yes | marker only |
| `CLAUDE_CODE_BRIDGE_SESSION_ID` | **No** — set only while Remote Control is active, removed when it ends (v2.1.199+) | opportunistic only |

MCP protocol carries nothing either: `clientInfo` is a generic
`{"name":"claude-ai","version":"0.1.0"}`; nothing in `_meta` or `roots/list`.

### 5.3 Solution — server-minted session UUID, no protocol change

At MCP server process startup, mint `sessionUuid = uuidv4()`.
**One MCP server process == one Claude Code session**, so this is exactly as stable as a
real session id would be, and dies exactly when the session does.

Implement the existing stub:

```ts
// identity.ts — replace the stub
function defaultSessionNameResolver(): string | null {
  return process.env.CLAUDE_CODE_BRIDGE_SESSION_ID ?? processSessionUuid;
}
```

`resolveSenderIdentity()` then returns `{ label, source: 'session' }` — the tier that was
always intended. **No wire-schema change. No `protocolVersion` bump.** The
`SenderIdentity` type and the `'session'` source value already exist.

### 5.4 Display name and keys

| Key | Source |
|---|---|
| `project_key` | `CLAUDE_PROJECT_DIR`, falling back to `repo.remoteUrl`, then cwd |
| `session_key` | the minted UUID |
| display label | `<repoName> · <branch> · <first-4-of-uuid>` via the existing `detectRepoContext()` |

### 5.5 Residual weakness and its fix

For `question`/`notification`, identity still rides the separate `sender_identity`
message. It can arrive late, out of order, or not at all.

**The archivist and the local store both resolve this by joining on `forMessageId` at the
store layer.** A message ingested without identity is stored with `session_key = NULL`
and patched when the sibling arrives — including on a later backfill. The UI never sees
the race; an unresolved message shows under an "Unattributed" group and moves out
silently when identity lands.

`plan_review` already carries `sender` inline and needs no join.

---

## 6. Pane 1 — Agents

A two-level tree: **project → session**. Sorted by most recent activity.

```
▾ Hitl_MCP                                    ● 2
    master · a3f2                             ● 2   2m ago
    feat/inbox · 9c81                         ○     41m ago
▾ mcqdb-api                                   
    main · 7b1e                               ◐     6m ago
  Unattributed                                ○ 1
```

### 6.1 Session state

Derived, like everything else:

| State | Glyph | Rule |
|---|---|---|
| `waiting` | ● | ≥1 message in `pending` that blocks the agent (question or plan_review) |
| `active` | ◐ | an event within the last 5 min, nothing pending |
| `idle` | ○ | no event in the last 5 min |
| `stale` | ○ dim | no event in the last 24 h |

> **Limitation, stated plainly:** the Inbox **cannot know a session has ended.** The MCP
> server publishes `cancel_review{reason:'agent_exited'}` on SIGINT/SIGTERM, but only if a
> plan review is outstanding. A session that exits cleanly with nothing pending emits no
> signal. `stale` is a decay heuristic, not a fact. Sessions are never auto-deleted; the
> user can archive a project row manually.

Selecting a project row shows all its sessions' messages merged. Selecting a session row
filters to that session. There is also an "All agents" root row.

---

## 7. Pane 2 — Message list

Newest first. This pane is a **list only** — no message body, no controls.

### 7.1 Header — field definitions

"Header" means the fixed set of fields every row shows, regardless of message type. This
is the uniform projection over three dissimilar message families.

| Field | Meaning | Source per type |
|---|---|---|
| **Type glyph** | which renderer pane 3 will use | `question` / `notification` / `plan_review` |
| **Title** | the one line that identifies this message | question: `question` text (or `"N questions"` in batch mode) · notification: `title` · plan review: `displayPath` |
| **Status pill** | folded state — see §7.2 | derived |
| **Age** | relative time since the message was published; absolute on hover | ntfy time of the request event |
| **Responder** | who closed it and from which device — blank while pending | `answer.respondedFrom` / `plan_review_response.respondedFrom` / `dismiss_notification.dismissedFrom` |
| **Context snippet** | first ~80 chars of the agent's `context` field, so you know why you were asked | `context` (required on `AskUserQuestion` and `ReviewPlan`; optional on `Notify`) |
| **Badges** | at-a-glance qualifiers | repo·branch · batch count (`N` when `questions[]` present) · revision (`r3` on plan reviews) · attachment · plaintext-warning when the envelope was unencrypted |

### 7.2 Status vocabulary — unified across the three types

This vocabulary does not exist today; each family expresses state differently. Defining
one is a core contribution of this design.

| Status | question | notification | plan_review |
|---|---|---|---|
| `pending` | published, no `answer` | published, not dismissed | published, no response |
| `answered` | `answer` received | — | `plan_review_response` received |
| `skipped` | `answer.skipped == true` | — | `verdict == 'skipped'` |
| `dismissed` | — | `dismiss_notification` seen | — |
| `cancelled` | — | — | `cancel_review{cancelled}` |
| `superseded` | — | — | `cancel_review{superseded}` |
| `agent_gone` | — | — | `cancel_review{agent_exited}` |
| `lost` | this device's response lost the race | — | `plan_review_ack{status:'lost'}` |
| `stale` | `pending`, but session `stale` | — | `pending`, but session `stale` |

For `answered` plan reviews, the pill carries the verdict as a sub-label:
`approved` / `changes requested` / `rejected`.

> **Deliberate asymmetry:** questions have no `cancelled` status. When the MCP host times
> out or aborts a call, the server throws `AbortedWaitError` **locally** and publishes
> nothing. No observer can see it. Such a question stays `pending` until it decays to
> `stale`. Fixing this would require a new message type — out of scope per §2.

### 7.3 Filters

Pinned at the top of the pane: `All` · `Needs you` (= `pending`) · `Answered` ·
`Notifications`. `Needs you` is the default when any message is pending.

---

## 8. Pane 3 — Detail, three renderers

Renderer chosen by the message's `type`. Each has a **pending** form and an **answered**
(read-only) form.

### 8.1 Notification renderer

Simplest. Read-mostly.

- `title` as heading, `body` rendered as markdown (`marked`, already vendored)
- `context` in a muted block if present
- sender badge, timestamp, project·branch
- **Dismiss** button → publishes `dismiss_notification`; every other device's
  notification window removes the card, which is existing behaviour
- Once dismissed, the row stays in the Inbox with status `dismissed`. **This is the
  behavioural difference from the existing popup**, which discards notifications entirely
  and auto-closes 1.5 s after its list empties.

### 8.2 Question renderer

- `context` block first — why you are being asked
- **Single mode** (`question` + `options`): radio when `allowMultiple == false`, checkbox
  when true. Each option shows `label` and, if present, `description`.
- **Batch mode** (`questions[]`, up to 4): a stepper. Each sub-question shows its `header`
  as a chip, and has its own `allowMultiple` / `allowOther`.
- **Preview**: when an option carries `preview`, focusing it renders that markdown in a
  side panel. Layout matches the existing `dialog.js` behaviour.
- **Additional Context**: free-text field when `allowOther`. Ctrl+Enter submits, matching
  the existing shortcut.
- **Submit** publishes `answer{questionId, selectedValues, otherText, skipped:false,
  subAnswers, respondedFrom: deviceName}`. **Skip** publishes the same with
  `skipped: true`.
- **Answered form**: the chosen options highlighted and locked, `otherText` shown verbatim,
  plus "answered by `<respondedFrom>` · `<time>`".

### 8.3 Plan review renderer

The richest, and the one with real constraints.

- **Two panes**: document left with line numbers, comment thread right. Mirrors the
  existing `review.js` (968 lines) — the Inbox should reuse that module, not reimplement it.
- **Body resolution**: `PlanPayloadRef.kind` is `inline` or `attachment`. Inline bodies
  arrive in the message; attachment bodies must be fetched from ntfy, and **ntfy expires
  attachments after 3 h**. The archivist must fetch and persist attachment bodies at
  ingest time or history becomes unreadable. This is the single hardest retention
  constraint in the design.
- **Integrity**: `snapshotHash` (`sha256:<hex>`) and `PlanPayloadRef.contentHash` must be
  verified after fetch. A mismatch renders the body read-only with an explicit warning
  rather than accepting it.
- **Diff mode**: when `revision > 1` and `isNewPlan == false`, show a diff against the
  prior revision rather than the whole plan. Prior revisions live in
  `~/.hitl/plans/<hash>/objects/` already.
- **Inline comments**: anchored `{path, startLine, endLine, side: 'old'|'new', comment}`.
- **Verdict**: `approved` / `changes_requested` / `rejected` / `skipped`.
  `changes_requested` and `rejected` require non-empty `overallFeedback` **or** ≥1 inline
  comment — enforced server-side by `normalizeResponseBody()`, so the Inbox must enforce
  it client-side too or submission will be rejected.
- **Drafts**: in-progress comments persist, matching the existing `drafts.rs` behaviour, so
  closing the Inbox mid-review loses nothing.

---

## 9. The reply race

The requirement: *"any application when it replies, any of these applications can also
register the message and update the status."*

### 9.1 Why this needs no new protocol

Responses are published to the **same shared topic** as requests. Therefore **every client
sees every answer**, including answers it did not send. A client learns "this was already
answered, by Kay9, from the laptop, at 10:32" purely by observing the `answer` event.

The existing 512-entry `consumedIds` FIFO only governs what the **MCP server** consumes
to unblock its own tool call. It has no bearing on what observers can see.

### 9.2 Winner rule

> **The winning response for a message is the first response event for that message in
> ntfy topic order.**

Every client observes the same total order (§4.3), so every client independently computes
the same winner. No arbiter, no lock, no service.

This also matches what the MCP server actually consumed, since the server reads the same
ordered stream.

### 9.3 UI behaviour

| Moment | Inbox shows |
|---|---|
| You press Submit | status `submitting`, controls locked, optimistic |
| Your event appears first in topic order | status `answered`, "answered by you" |
| A different response appears earlier | status `lost` — "Answered by **Kay9** on **laptop**, 10:32", with their answer displayed and yours discarded |
| Another device answers while you are typing | banner slides in: "Answered elsewhere", form locks, no data loss — your draft is retained but marked non-submittable |

For plan reviews the MCP server additionally sends `plan_review_ack{status:'lost'}` within
its 45 s `LATE_RESPONSE_WINDOW_MS`. The Inbox folds that too, as confirmation — but it does
not depend on it, because the ack does not exist for questions.

### 9.4 Honest limitation

If two devices submit within the same network round-trip, one submission is discarded.
This is inherent to a single-writer-wins model and is the correct behaviour: the agent
received exactly one answer, and the Inbox reports truthfully which one.

---

## 10. Data model

Two layers per client: an immutable log, and rebuildable projections.

```sql
-- Layer 1: the log. Append-only. Never updated.
CREATE TABLE events (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,  -- local ingest order
  ntfy_id     TEXT NOT NULL UNIQUE,               -- ntfy's id: the total-order key
  ntfy_time   INTEGER NOT NULL,
  message_id  TEXT NOT NULL,
  type        TEXT NOT NULL,
  subject_id  TEXT,        -- questionId | reviewId | notificationId | forMessageId
  payload     TEXT NOT NULL  -- full decrypted JSON, verbatim
);
CREATE INDEX idx_events_subject ON events(subject_id);

-- Layer 2: projections. Derived. Droppable and rebuildable at any time.
CREATE TABLE messages (
  message_id   TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  session_key  TEXT,          -- NULL until sender_identity joins
  project_key  TEXT,
  created_at   INTEGER NOT NULL,
  status       TEXT NOT NULL, -- folded, §7.2
  verdict      TEXT,
  responder    TEXT,
  responded_at INTEGER,
  title        TEXT NOT NULL,
  context      TEXT,
  repo_name    TEXT,
  repo_branch  TEXT
);
CREATE TABLE sessions (session_key TEXT PRIMARY KEY, project_key TEXT, label TEXT, first_seen INTEGER, last_seen INTEGER);
CREATE TABLE projects (project_key TEXT PRIMARY KEY, name TEXT, last_seen INTEGER);
CREATE TABLE bodies   (content_hash TEXT PRIMARY KEY, bytes BLOB);  -- fetched attachments
```

**Invariant:** `messages`, `sessions`, `projects` contain nothing that cannot be
regenerated by replaying `events`. `DROP` and rebuild is always a valid recovery. This is
what makes the fold trustworthy — there is no path by which stored status can drift from
observed events.

`bodies` is the exception: it holds attachment bytes fetched before ntfy's 3 h expiry.
Those are not recoverable from the log, which is precisely why they are stored.

Location: `~/.hitl/inbox.db` (respecting `$HITL_HOME`, as the existing stores do).

---

## 11. Archivist

A headless binary sharing `hitl-transport`.

- Subscribes 24/7, writes every event to its own `events` table, **forever**.
- Fetches and persists every attachment body at ingest, beating the 3 h expiry.
- Serves backfill over HTTP on `127.0.0.1` only: `GET /events?since=<seq>` → NDJSON.
- Ships as an OS login item.

**It is an optimization, not a dependency.** Every client works when the archivist is
down; it simply cannot see further back than ntfy's own retention. On startup a client asks
the archivist for anything it missed, and falls back to `?poll=1&since=all` if the
archivist is unreachable.

**That reach is two numbers, not one** (corrected 2026-08-22, after the Inbox shipped and
the single-number version proved misleading). ntfy retains *messages* for 12 h but deletes
*attachments* after 3 h, and a plan body larger than 2 KB spills to an attachment. So
without the archivist:

| Body | Reach without the archivist |
|---|---|
| Inline (≤ 2 KB) | 12 h — the message carries it |
| Spilled to an attachment | **3 h** — after that the bytes are gone and it resolves `gone`, permanently |

A client that was *running* when the message arrived is not bound by the 3 h figure: it
captures the attachment at ingest and keeps it. The 3 h ceiling applies to what a client
can still recover for a message it did not witness — which is exactly the case the
archivist exists to cover, and is why "12 h" understated its value rather than overstating
it.

This matters most for mobile (see `2026-08-21-inbox-mobile-design.md` §5.2), because a
phone can never reach the archivist on `127.0.0.1` and therefore lives permanently under
the 3 h ceiling for spilled bodies.

Because it runs on the user's own machine and already has `encryptionKey` from
`~/.hitl/config.json`, it stores decrypted payloads. The database inherits the security
posture of the config file — which today is a plaintext AES key in the home directory.
That is the existing posture, unchanged, and is noted rather than fixed here.

### 11.1 Self-hosted ntfy changes the trade-off

This deployment does not use ntfy.sh. `~/.hitl/config.json` points at
`https://local-gb.mcqdb.com/ntfy/`, a self-hosted instance (confirmed healthy). ntfy's
retention is server-configurable:

| Setting | ntfy.sh default | Self-hosted |
|---|---|---|
| `cache-duration` | 12 h | any duration, or `0` for no cache |
| `attachment-expiry-duration` | 3 h | configurable |

**This offers a cheaper alternative to the archivist**: raise `cache-duration` on the
self-hosted server and ntfy itself becomes the long-retention log. A client that has been
offline for a week can then backfill straight from `?poll=1&since=all`.

Trade-offs against the archivist:

| | Long `cache-duration` | Archivist |
|---|---|---|
| Work to build | **none** — a config change | a new binary |
| History depth | as configured | forever |
| Survives ntfy data loss | no | **yes** — independent copy |
| Attachment bodies | expire per `attachment-expiry-duration` | **captured at ingest, kept forever** |
| Queryable | no — replay only | yes, SQL |
| Must be running | ntfy already is | one more thing to keep alive |

**Recommendation:** do both, in that order. Raise `cache-duration` first — it is free and
immediately removes the 12 h cliff. Keep the archivist in the plan for durability,
attachment capture, and query, but it becomes a Phase 1 *convenience* rather than a
prerequisite. This is the strongest argument for the "drop the archivist from v1" option
if you want a shorter path to Phase 2.

---

## 12. LLM summarization

*Added from review feedback: "support for using LLMs to summarize the state of an agent,
e.g. what the agent has completed, or ability to summarize or explain different aspects of
Plan/Question".*

Once the Inbox holds a durable, per-session event history, it has something no other part
of the system has: **the full narrative of what an agent has been doing.** That makes
summarization cheap to add and genuinely useful — it is the natural payoff of §10.

### 12.1 Three distinct surfaces

| Surface | Question it answers | Input |
|---|---|---|
| **Agent digest** (pane 1) | "What has this session been doing?" | all messages for one `session_key`, chronological |
| **Message explainer** (pane 3) | "What is this actually asking me, and what do the options mean?" | one message + its `context` |
| **Catch-up** (pane 2 header) | "What happened while I was away?" | all messages since last seen, across sessions |

The agent digest is the highest-value one. It directly answers "what has the agent
completed" — reconstructed from the questions it asked, the plans it proposed, the verdicts
it received, and the notifications it sent.

### 12.2 Design constraints

- **Summaries are cached artifacts, not derived state.** This is the one deliberate
  exception to §4.2. A summary is expensive and non-deterministic, so it is stored keyed by
  `(scope, content_hash)` and invalidated when new events arrive for that scope. It is never
  part of the fold.
- **Never on the critical path.** Summarization is strictly additive. The Inbox is fully
  functional with the feature disabled, offline, or the API key absent.
- **Explicitly triggered by default.** Auto-summarizing every session on arrival burns
  tokens on things you never read. Default to on-demand, with opt-in auto-digest for
  sessions you have starred.
- **Privacy is a real decision, not a footnote.** Plan bodies and question context contain
  source code and repository detail. Sending them to a hosted API is a meaningfully
  different posture from today, where content only ever reaches your own ntfy server. This
  must be **off by default** and enabled explicitly.

### 12.3 Storage

```sql
CREATE TABLE summaries (
  scope        TEXT NOT NULL,   -- 'session' | 'message' | 'catchup'
  scope_key    TEXT NOT NULL,   -- session_key | message_id | cursor
  content_hash TEXT NOT NULL,   -- hash of the exact input; invalidates on new events
  model        TEXT NOT NULL,
  summary      TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (scope, scope_key, content_hash)
);
```

### 12.4 Scope

**This is v2, not v1.** It depends on Phase 2 (the event history) existing first, and it
introduces an external API dependency, a key to manage, and a cost model — none of which
the Inbox otherwise has. Sequencing it after the core Inbox works keeps Phase 2 shippable.

Open: which provider and model; where the key lives (a new field in `~/.hitl/config.json`
vs. the OS keychain); whether to support a local model for the privacy-sensitive case.

## 13. Mobile (later, not v1)

> **Superseded by `2026-08-21-inbox-mobile-design.md`.** Kept for provenance. Two
> claims below did not survive contact with research: iOS is not merely unscaffolded
> but **impossible to build from Windows** (Tauri requires macOS-only Xcode), and the
> "12 h window" figure is corrected in §11 above — a phone lives under a **3 h**
> ceiling for any plan body that spilled to an attachment. The sketch below is also
> silent on the decision that shapes the whole design: a Tauri Android app's Rust
> backend is suspended when backgrounded, so it cannot hold a live subscription.

Tauri v2 supports mobile; the client simply never scaffolded it. The path:

1. `hitl-inbox` already depends on nothing desktop-specific except its window layout.
2. `tauri android init` / `tauri ios init` on `hitl-inbox`.
3. Collapse the 3 panes into stacked navigation at narrow widths.
4. Drop `#![windows_subsystem = "windows"]` for mobile targets.

**A phone joins by learning `topicId` + `encryptionKey`** — the same two secrets every
device already shares. No server to reach, no tunnel, no port forwarding. This is the
payoff of choosing the derived model over a central service.

Caveat stated plainly: a phone on cellular cannot reach the archivist on `127.0.0.1`. It
sees ntfy's 12 h window plus whatever it has stored locally. Extending backfill to the
phone would require exposing the archivist beyond localhost, which is a separate decision
with its own auth requirements — deliberately deferred.

---

## 14. Testing

| Layer | Approach |
|---|---|
| **The fold** | Pure function `Vec<Event> -> MessageState`. Table-driven unit tests: every status in §7.2, every race ordering, out-of-order identity joins. This is the highest-value test surface in the project and it is trivially testable *because* the fold is pure. |
| Transport crate | Golden-file NDJSON event streams; chunk reassembly; AES round-trip; attachment expiry handling. |
| Refactor regression | Existing Playwright (`client/tests/*.spec.ts`) + Jest suites must pass unchanged after the crate extraction. This is the gate on Phase 0. |
| Inbox UI | Playwright against the harness pattern already used by the client. |
| Archivist | Ingest an offline stream, assert full replay fidelity and attachment capture. |

> Note: **no CI workflow currently runs tests on PRs** — both workflows trigger only on
> `v*` tags. A PR test workflow should be added as part of Phase 0, or the regression gate
> is manual.

---

## 15. Phasing

| Phase | Deliverable | Gate |
|---|---|---|
| **0** | Extract `crates/hitl-transport`; cut `hitl-client` over to it. Add a PR test workflow. | Existing Playwright + Jest suites pass unchanged. Zero behaviour change. |
| **1** | Implement `defaultSessionNameResolver` (§5.3). Archivist + `events` log + attachment capture. | Identity `source` is `'session'`; archivist survives a restart with no gaps. |
| **2** | `hitl-inbox`, **read-only**. Three panes, the fold, all statuses. | Every message from every agent visible with correct status. |
| **3** | Reply from the Inbox: all three renderers, race handling (§9). | Two clients racing produce one winner and both agree who it was. |
| **4** | LLM summarization (§12): agent digest, message explainer, catch-up. | Digest of a real session is accurate and useful; Inbox still fully works with it disabled. |
| **5** | Mobile targets. | — |

Phase 2 is the first phase that delivers the stated primary value. Phases 0–1 are the
foundation it needs; neither is optional, because without 0 the transport is duplicated
and without 1 pane 1 cannot group correctly.

---

## 16. Open questions

1. **Retention policy for the archivist.** Forever, or a cap? Forever is small — these are
   text messages — but plan-review attachment bodies can be up to 8 MB decompressed.
2. **Inbox UI stack.** The existing client is vanilla JS + vendored markdown libs, no
   framework. A 3-pane app with virtualized lists is a step up in complexity. Match the
   existing stack, or introduce a framework for this app only?
3. **Does the Inbox replace the popups?** Currently both run. If the Inbox is always
   open, the popups may become noise — but they are what the MCP server auto-launches and
   depends on.
4. **Notification dismissal semantics.** Existing popup discards; the Inbox retains with
   status `dismissed`. Confirm that divergence is wanted.
5. **Orphan handling — surfaced by a real incident during this design session.** The
   client replays unsettled reviews from the ntfy cache on startup, so a review whose
   publishing MCP process has died gets resurrected as a window. Two review windows were
   open simultaneously, the older orphan was approved, and the response went nowhere —
   the client logged only `published but not acknowledged within 30s`. The Inbox is the
   natural place to fix this: it can tell a live request from an orphan (§6.1 session
   state) and should mark orphans explicitly rather than presenting them as actionable.
   Should the Inbox go further and auto-publish `cancel_review` for orphans, or only
   display them as dead?

---

## Appendix — incident that informed §16.5

While preparing this document for review, `ReviewPlan` silently failed twice. Root cause
was **not** in this design's scope but is worth recording, since it shaped §6.1 and §16.5:

- `@achieveai/hitl-mcp-server@2.11.2` ships a **v2.9.6 client binary**. That binary
  contains no `plan_review`, `plan_review_ack`, `cancel_review`, or `sender_identity`
  handlers at all, so it silently drops every plan review while questions (protocolVersion
  1) keep working.
- `ensureClientRunning()` (`setup.ts:102-154`) only checks whether *a* client process
  exists, not its version — so the stale client satisfied the check and the correct
  bundled v2.11.3 client never launched.

Both are real bugs in the shipping product, independent of the Inbox. Full root-cause
write-up, including the hypotheses that were tested and refuted, is in
`scratchpad/conversation_memories/llm-inbox-design/05-reviewplan-bug-rootcause.md`
(local only — `scratchpad/` is gitignored).
