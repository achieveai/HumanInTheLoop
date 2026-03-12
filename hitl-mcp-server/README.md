# HITL MCP — Human-in-the-Loop Across All Your Machines

A cross-machine notification system that lets AI agents (via MCP) ask humans for input. Questions pop up as **native chromeless dialogs** on **all your devices** simultaneously — answer from any one, and the rest dismiss automatically.

## How It Works

```
┌─────────────┐      ┌──────────────┐      ┌───────────────────────┐
│  LLM Agent  │─────▶│  MCP Server  │─────▶│     ntfy.sh topic     │
│  (Claude…)  │      │  (ask_human) │      │  (pub/sub messaging)  │
└─────────────┘      └──────────────┘      └───────┬───────────────┘
                           ▲                        │
                           │ answer                 ▼
                     ┌─────┴────────┐      ┌───────────────────────┐
                     │  ntfy.sh     │◀─────│  Tauri Client (tray)  │
                     │  (answer)    │      │  on ALL your machines  │
                     └──────────────┘      └───────────────────────┘
```

1. An LLM calls the `ask_human` tool with a question, options, and context
2. The MCP server auto-detects the git repo and publishes the question to your ntfy.sh topic
3. **All** your Tauri client apps receive the notification and pop up a native dialog with a doorbell sound
4. You answer on **any** device — the answer flows back through ntfy.sh to the MCP server
5. All other dialogs dismiss automatically

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
  "soundEnabled": true
}
```

### 4. Set up additional machines

Copy the **same** `topicId` to `~/.hitl/config.json` on every machine where you want to receive notifications. Each machine needs:
- The same `topicId` (shared secret)
- The HITL client app running in the system tray

## MCP Tools

### `ask_human`

Sends a question to all connected devices. The human responds from any one.

| Parameter | Required | Description |
|---|---|---|
| `question` | ✅ | The question to ask |
| `context` | ✅ | What project/work the LLM is doing |
| `options` | ✅ | Array of `{ label, value, description? }` choices |
| `allowMultiple` | ❌ | Allow multi-select (default: `true`) |
| `allowOther` | ❌ | Show free-text input (default: `true`) |
| `timeout` | ❌ | Timeout in ms (default: `300000` = 5 min) |

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

### `setup`

Auto-configures the HITL system. Takes no parameters. Checks config, finds the client binary, and launches it.

## CLI Commands

```bash
hitl init                    # Create ~/.hitl/config.json with a new topic
hitl config show             # Print current config
hitl config set-topic <id>   # Set topic ID (sync across machines)
hitl test                    # Send a test question to verify connectivity
```

## Client App Features

- **System tray** — lives in your tray, ready for questions
- **Chromeless dialogs** — frameless, phone-shaped popup with custom drag bar
- **Doorbell sound** — plays a notification sound when a question arrives
  - 40% volume on local console, 25% on remote desktop sessions
- **Multi-device** — all devices get the question, first response wins
- **Always on top** — dialogs appear above other windows

## Architecture

```
hitl-mcp-server/
├── server/          # MCP Server (Node.js/TypeScript)
│   └── src/
│       ├── mcp-server.ts      # MCP entry point + tool handlers
│       ├── setup.ts           # Setup tool logic
│       ├── ntfy-transport.ts  # ntfy.sh pub/sub
│       ├── git-context.ts     # Git repo detection
│       ├── config.ts          # Config management
│       └── cli.ts             # CLI commands
├── client/          # Tauri Client App
│   ├── src-tauri/   # Rust backend
│   │   └── src/
│   │       ├── main.rs    # App entry + ExitRequested handler
│   │       ├── ntfy.rs    # ntfy subscription + question handling
│   │       ├── sound.rs   # Notification sound (rodio, RDP-aware)
│   │       ├── tray.rs    # System tray icon + menu
│   │       ├── config.rs  # Config reader
│   │       └── types.rs   # Message types
│   └── src/         # Web frontend (webview)
│       ├── index.html
│       ├── styles.css   # Chromeless layout, pinned footer
│       ├── dialog.js    # Dialog rendering, collapsible context
│       └── app.js       # App entry, event handling
├── shared/          # Shared TypeScript protocol types
└── sounds/          # Notification audio files
```

## Security

- **Topic ID is the secret** — a long random UUID that acts as an authentication token
- Anyone with the topic ID can read/publish messages on the topic
- For sensitive environments, self-host ntfy or use [ntfy access tokens](https://docs.ntfy.sh/publish/#access-tokens)
- Config file is stored in user home directory (`~/.hitl/`)

## Building from Source

```bash
# Install dependencies
npm install

# Build everything (server + shared + client)
npm run build

# Build individual components
npm run build:shared
npm run build:server
cd client && npm run build    # Requires Rust toolchain for Tauri
```
