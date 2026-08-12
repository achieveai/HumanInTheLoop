# HITL MCP — Human-in-the-Loop Across All Your Machines

A cross-machine notification system that lets AI agents (via MCP) ask humans for input. Questions pop up as **native chromeless dialogs** on **all your devices** simultaneously — answer from any one, and the rest dismiss automatically. Agents can also send a whole implementation plan for **line-anchored review**, and get back comments pinned to specific lines.

## How It Works

```
┌─────────────┐      ┌────────────────────┐      ┌───────────────────────┐
│  LLM Agent  │─────▶│     MCP Server     │─────▶│     ntfy.sh topic     │
│  (Claude…)  │      │ (AskUserQuestion / │      │  (pub/sub messaging)  │
│             │      │     ReviewPlan)    │      └───────┬───────────────┘
└─────────────┘      └────────────────────┘              │
                           ▲                             ▼
                           │ answer              ┌───────────────────────┐
                     ┌─────┴────────┐            │  Tauri Client (tray)  │
                     │  ntfy.sh     │◀───────────│  on ALL your machines │
                     │  (answer)    │            └───────────────────────┘
                     └──────────────┘
```

1. An LLM calls `AskUserQuestion` (a choice) or `ReviewPlan` (a markdown document to comment on)
2. The MCP server auto-detects the git repo and publishes to your ntfy.sh topic
3. **All** your Tauri client apps receive it and pop up a native window with a doorbell sound
4. You answer on **any** device — the answer flows back through ntfy.sh to the MCP server
5. All other windows dismiss automatically

## Quick Start

### 1. Add the MCP server to your AI tool

Add to your `.mcp.json` or MCP client config:

```json
{
  "mcpServers": {
    "hitl": {
      "command": "node",
      "args": ["/path/to/hitl-mcp-server/server/dist/mcp-server.js"]
    }
  }
}
```

### 2. Run setup (via your AI agent)

Ask your AI agent to call the `setup` tool — it will:
- Create `~/.hitl/config.json` with a unique topic ID (if it doesn't exist)
- Find the HITL client binary on your machine
- Launch it in the system tray (if not already running)

### 3. Initialize config manually (alternative)

```bash
cd server && npm install && npm run build
npx hitl init
```

This creates `~/.hitl/config.json`:

```json
{
  "topicId": "hitl-a1b2c3d4-...",
  "ntfyUrl": "https://ntfy.sh",
  "deviceName": "MY-LAPTOP",
  "soundEnabled": true,
  "encryptionKey": "64 hex characters"
}
```

### 4. Set up additional machines

Copy the **same** `topicId` **and** `encryptionKey` to `~/.hitl/config.json` on every machine where you want to receive notifications. Each machine needs:
- The same `topicId` (shared secret)
- The same `encryptionKey`, or it will see the traffic but not be able to read it
- The HITL client app running in the system tray

## MCP Tools

The server exposes four tools: `AskUserQuestion`, `ReviewPlan`, `Notify`, and `setup`.

### `AskUserQuestion`

Sends a question to all connected devices. The human responds from any one. **Blocks** until someone answers — see [Blocking and host timeouts](#blocking-and-host-timeouts).

| Parameter | Required | Description |
|---|---|---|
| `question` | ✅¹ | The question to ask |
| `context` | ✅ | What project/work the LLM is doing |
| `options` | ✅¹ | Array of `{ label, value, description?, preview? }` choices |
| `questions` | ✅¹ | Batch mode: array of up to 4 sub-questions, each `{ question?, header?, options, allowMultiple?, allowOther? }` |
| `allowMultiple` | ❌ | Allow multi-select (default: `true`) |
| `allowOther` | ❌ | Show free-text input (default: `true`) |

¹ Supply **either** `question` + `options` **or** `questions`, not both.

**Response:**

```json
{
  "success": true,
  "timestamp": 1710000000000,
  "selectedValues": ["option_a"],
  "context": "User's additional notes",
  "responseType": "selection_with_context",
  "respondedFrom": "MY-LAPTOP"
}
```

> **The `timeout` parameter was removed in 2.10.0** and should not be re-added. It never controlled anything the caller cared about: the wait is now released by the human answering, by the MCP host cancelling the request, or not at all. Removing it is safe for already-installed clients — the Rust side declares the field `Option<u64>` with `skip_serializing_if`, so an absent key deserializes to `None`, and nothing reads it.

### `ReviewPlan`

Gets **line-anchored** human review of an implementation plan you have written to a markdown file. The plan opens as a two-pane review window on every subscribed device; the human selects line ranges, attaches comments to them, and returns a verdict. **Blocks** until they submit.

Use this instead of pasting a plan into `AskUserQuestion` whenever you want feedback on specific lines rather than a yes/no.

| Parameter | Required | Description |
|---|---|---|
| `filePath` | ✅ | Absolute or cwd-relative path to the markdown plan file (`.md` or `.markdown`, up to 1 MB) |
| `context` | ✅ | What project/work the LLM is doing |
| `summary` | ❌ | Short prose framing shown above the document — what changed, or what you most want feedback on |

**Response:**

```json
{
  "success": true,
  "timestamp": 1710000000000,
  "respondedFrom": "MY-PHONE",
  "verdict": "changes_requested",
  "overallFeedback": "The migration order is wrong.",
  "inlineComments": [
    {
      "path": "docs/plan.md",
      "startLine": 42,
      "endLine": 47,
      "side": "new",
      "comment": "This assumes the backfill already ran."
    }
  ],
  "revision": 3,
  "isNewPlan": false,
  "snapshotHash": "sha256:9f2a…"
}
```

- `verdict` is one of `approved` · `changes_requested` · `rejected` · `skipped` · `cancelled`
- `inlineComments` is always present (possibly empty) and always in the same order for the same set of comments, regardless of the order the human clicked them in
- `startLine`/`endLine` are in the source-line space of the file you passed; `side` is `new` (the current file) or `old` (the baseline it was diffed against)
- `changes_requested` and `rejected` always carry either `overallFeedback` or at least one inline comment — the server rejects a submission that carries neither

**Do not modify the file while the call is blocked.** `snapshotHash` identifies the exact bytes the human reviewed. If you rewrite the file mid-review, their approval applies to text that no longer exists.

#### Revisions and diffs

Call `ReviewPlan` again with the same file after making the requested changes, and the human sees **what changed** rather than the whole plan again:

- Revision 1 is diffed against the file's committed content (`HEAD:<path>`) if it is tracked in git, and shown as entirely new if it is not.
- Revision 2 and later are diffed against **the snapshot the human last reviewed**, not against git — so edits you made and edits someone else committed do not get mixed together.
- The revision number increments per plan, and `isNewPlan` tells you whether this is the first time this file has been reviewed.
- Line endings are preserved verbatim; a CRLF file is not silently normalized, so comment anchors line up with what is actually on disk.

Snapshots live under `~/.hitl/plans/` (override the root with `HITL_HOME`), keyed by the repository and the file path, so a plan is tracked across separate agent sessions. Content is stored content-addressed; nothing is ever overwritten in place.

### `Notify`

Sends a notification to all devices and **returns immediately** — it does not block. Use it for progress updates, completion messages, and anything the human should see but need not answer.

| Parameter | Required | Description |
|---|---|---|
| `title` | ✅ | Short title (e.g. "Build Complete") |
| `body` | ✅ | Notification body text; supports markdown |
| `context` | ❌ | What triggered this notification |

### `setup`

Auto-configures the HITL system. Takes no parameters. Checks config, finds the client binary, and launches it.

## Blocking and host timeouts

`AskUserQuestion` and `ReviewPlan` block the agent until a human responds. How long they are *allowed* to block is decided by your MCP host, not by this server.

While a call is blocked the server emits MCP progress notifications every 15 seconds. Hosts that set **`resetTimeoutOnProgress`** treat each of those as a sign of life and extend the deadline, so the call survives as long as it needs to. That option **defaults to `false` in the MCP SDK**: on a host that leaves it alone, the request is cancelled at the SDK's default of 60 seconds no matter what the server does.

So:

- **The server cannot enforce, extend, or override the host's timeout.** It can only keep signalling that it is alive.
- **If your host does not opt in**, expect a blocked call to fail after roughly a minute. That is the host cancelling, not the human failing to answer — the question is still sitting on the user's devices.
- **If your host does opt in** (or lets you raise the per-request timeout), the call waits for the human.

Cancellation is honoured either way: when the host cancels a request, the server drops the wait and releases the ntfy subscription immediately, and on shutdown it publishes a cancellation so any open review window on your devices closes instead of waiting for an agent that has exited.

## CLI Commands

```bash
hitl init                    # Create ~/.hitl/config.json with a new topic
hitl config show             # Print current config
hitl config set-topic <id>   # Set topic ID (sync across machines)
hitl test                    # Send a test question to verify connectivity
hitl client                  # Launch the HITL desktop client app
hitl help                    # Show usage
```

## Client App Features

- **System tray** — lives in your tray, ready for questions
  - The menu shows **live connection status** and how long ago the last message arrived
  - **Cancel Pending Review** closes an open review and releases the blocked agent
  - **Open Log** opens the client log in your OS text handler
- **Chromeless dialogs** — frameless, phone-shaped popup with custom drag bar
- **Two-pane review window** — the plan on one side, the diff and your comments on the other
- **Doorbell sound** — plays a notification sound when a question arrives
  - 40% volume on local console, 25% on remote desktop sessions
- **Multi-device** — all devices get the question, first response wins
- **Always on top** — dialogs appear above other windows

### Diagnosing the client

The client writes to **`~/.hitl/client.log`**, rotating to `client.log.1` past 5 MB (one generation kept). Set `HITL_LOG` to `trace`, `debug`, `info`, `warn`, or `error` to change the level; the default is `info`.

This file is the only way to see what the client is doing. It is built with `#![windows_subsystem = "windows"]` so that launching it does not flash a console window, which means **stderr is discarded on Windows** — without the log there is nothing to read.

## Architecture

```
hitl-mcp-server/
├── server/          # MCP Server (Node.js/TypeScript)
│   └── src/
│       ├── mcp-server.ts      # MCP entry point + tool handlers
│       ├── setup.ts           # Setup tool logic
│       ├── ntfy-transport.ts  # ntfy.sh pub/sub, reconnect, attachments
│       ├── payload.ts         # gzip + encrypt, inline-or-attachment
│       ├── crypto.ts          # AES-256-GCM envelope
│       ├── chunking.ts        # Split oversized question messages
│       ├── plan-file.ts       # Validated markdown plan reader
│       ├── snapshot-store.ts  # Content-addressed plan revisions
│       ├── plan-diff.ts       # Full-document unified diff
│       ├── plan-review.ts     # Verdict + inline-comment rules
│       ├── git-context.ts     # Git repo detection + HEAD baseline
│       ├── config.ts          # Config management
│       └── cli.ts             # CLI commands
├── client/          # Tauri Client App
│   ├── src-tauri/   # Rust backend
│   │   └── src/
│   │       ├── main.rs          # App entry + ExitRequested handler
│   │       ├── ntfy.rs          # ntfy subscription + message handling
│   │       ├── payload.rs       # Payload decode + attachment fetch
│   │       ├── payload_store.rs # Received plan bodies
│   │       ├── crypto.rs        # AES-256-GCM envelope
│   │       ├── chunking.rs      # Chunk reassembly
│   │       ├── logging.rs       # ~/.hitl/client.log + rotation
│   │       ├── sound.rs         # Notification sound (rodio, RDP-aware)
│   │       ├── tray.rs          # System tray icon + menu
│   │       ├── window_utils.rs  # Window placement + focus behaviour
│   │       ├── config.rs        # Config reader
│   │       └── types.rs         # Message types
│   └── src/         # Web frontend (webview)
│       ├── index.html
│       ├── styles.css       # Chromeless layout, pinned footer
│       ├── dialog.js        # Dialog rendering, collapsible context
│       ├── app.js           # App entry, event handling
│       ├── notifications.*  # Notification window
│       └── review.*         # Two-pane plan review window
└── sounds/          # Notification audio files
```

## Security

- **Topic ID is the secret** — a long random UUID that acts as an authentication token
- Anyone with the topic ID can see that messages are flowing on the topic
- **Message bodies are encrypted** with the `encryptionKey` from your config (AES-256-GCM), so the topic alone does not reveal question text, plan contents, or your review comments. Every machine sharing a topic must share the key.
- Plan bodies too large to inline are uploaded as ntfy attachments — encrypted the same way, and sent under a random filename so the real path never appears in ntfy's plaintext metadata
- For sensitive environments, self-host ntfy or use [ntfy access tokens](https://docs.ntfy.sh/publish/#access-tokens)
- Config and plan snapshots are stored in the user home directory (`~/.hitl/`)

## Building from Source

```bash
# Install dependencies
npm install

# Build everything (server + client)
npm run build

# Build individual components
npm run build:server
npm run build:client   # Requires Rust toolchain for Tauri
```
