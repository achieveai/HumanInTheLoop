# HITL MCP — Human-in-the-Loop Across All Your Machines

A cross-machine notification system that lets AI agents (via MCP) ask humans for input. Questions pop up as **native windows** on **all your devices** simultaneously — answer from any one, and the rest dismiss.

## Architecture

```
LLM → MCP Server (ask_human) → ntfy.sh pub/sub → Tauri Client Apps (all machines)
                                     ↑                        │
                                     └── answer ──────────────┘
```

- **MCP Server** (`server/`): Node.js MCP server exposing `ask_human` tool. Publishes questions to ntfy.sh, waits for answers.
- **Tauri Client** (`client/`): Native system tray app that subscribes to ntfy.sh. Pops up a webview dialog when questions arrive.
- **Shared Types** (`shared/`): TypeScript protocol definitions shared between server and client.

## Quick Start

### 1. Initialize Config

```bash
cd server && npm install && npm run build
npx hitl init
```

This creates `~/.hitl/config.json` with a unique topic ID:

```json
{
  "topicId": "hitl-a1b2c3d4-...",
  "ntfyUrl": "https://ntfy.sh",
  "deviceName": "MY-LAPTOP",
  "soundEnabled": true
}
```

### 2. Copy Config to Other Machines

Copy the **same** `~/.hitl/config.json` (or just the `topicId`) to every machine where you want to receive notifications.

### 3. Install Tauri Client (on each machine)

```bash
cd client && npm install && npm run build
```

Run the built app — it sits in your system tray and listens for questions.

### 4. Configure MCP

Add to your MCP client config (e.g., Claude Desktop):

```json
{
  "mcpServers": {
    "hitl": {
      "command": "node",
      "args": ["path/to/server/dist/mcp-server.js"]
    }
  }
}
```

## How It Works

1. An LLM calls the `ask_human` tool with a question, options, and context
2. The MCP server auto-detects the git repo and publishes the question to your ntfy.sh topic
3. All your Tauri clients receive the notification and pop up a native dialog
4. You answer on any device — the answer flows back through ntfy.sh
5. All other popups dismiss, and the MCP server returns the response to the LLM

## CLI Commands

```bash
hitl init                    # Create ~/.hitl/config.json with a new topic
hitl config show             # Print current config
hitl config set-topic <id>   # Set topic ID (sync across machines)
hitl test                    # Send a test question to verify connectivity
```

## Tool Schema

The `ask_human` tool accepts:

| Parameter | Required | Description |
|---|---|---|
| `question` | ✅ | The question to ask |
| `context` | ✅ | What project/work the LLM is doing |
| `options` | ✅ | Array of `{ label, value, description? }` |
| `allowMultiple` | ❌ | Allow multi-select (default: true) |
| `allowOther` | ❌ | Show free-text field (default: true) |
| `timeout` | ❌ | Timeout in ms (default: 300000) |

The server auto-detects `repo` (name, branch, remote URL) from the git context.

## Project Structure

```
hitl-mcp-server/
├── server/          # MCP Server (Node.js/TypeScript)
│   └── src/
│       ├── mcp-server.ts      # MCP entry point
│       ├── ntfy-transport.ts  # ntfy.sh pub/sub
│       ├── git-context.ts     # Git repo detection
│       ├── config.ts          # Config reader
│       └── cli.ts             # CLI helper
├── client/          # Tauri Client App
│   ├── src-tauri/   # Rust backend
│   │   └── src/
│   │       ├── main.rs   # App entry, tray, commands
│   │       ├── ntfy.rs   # ntfy subscription + publish
│   │       ├── config.rs # Config reader
│   │       ├── tray.rs   # System tray
│   │       └── types.rs  # Rust message types
│   └── src/         # Web frontend (rendered in native webview)
│       ├── index.html
│       ├── styles.css
│       ├── dialog.js
│       └── app.js
├── shared/          # Shared protocol types
│   └── src/
│       └── index.ts
└── package.json     # Workspace root
```

## Security

- Your ntfy topic ID is a long random UUID — effectively a secret key
- Anyone with the topic ID can read/publish messages
- Use ntfy access tokens for additional security
- Consider self-hosting ntfy for sensitive environments
