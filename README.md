# Human-in-the-Loop MCP

Let an AI agent ask questions, send notifications, and request line-by-line plan reviews. Respond from a running HITL desktop client or the Inbox connected to the same topic.

## Choose the component you need

| Component | What it does |
| --- | --- |
| **MCP server** | Exposes `AskUserQuestion`, `ReviewPlan`, `Notify`, `UpdateWork`, `ReadWork`, and `setup` to your agent. |
| **HITL Client** | Tray app that shows incoming questions and reviews as popup windows. |
| **HITL Inbox** | Persistent window for browsing notifications, answering questions, and reviewing plans. |
| **Archivist** | Optional headless recorder. Keeps history and attachment bodies available to a local Inbox. |

Messages travel through [ntfy](https://ntfy.sh). Devices must use the same topic URL, topic ID, and encryption key. The server auto-launches the **tray client**, not Inbox.

## Start using HITL

Install a supported [Node.js LTS](https://nodejs.org/en/download), then run:

```sh
npm install -g @achieveai/hitl-mcp-server
hitl init
hitl client
```

Keep the generated encryption key private. Do not paste `hitl init` output or your configuration into an issue.

Add this entry to your MCP host's configuration, then restart that host:

```json
{
  "mcpServers": {
    "hitl": {
      "command": "hitl-mcp-server",
      "args": []
    }
  }
}
```

Ask your agent to send a test notification or question. `hitl test` also sends a real test question to the configured topic.

See [setup and configuration](hitl-mcp-server/README.md#setup-and-configuration) for explicit `npx` commands, multiple machines, and running without automatic tray-client launch.

## Use Inbox

Build Inbox from this checkout, or download an **Inbox-named** asset when one is offered on [GitHub Releases](https://github.com/achieveai/HumanInTheLoop/releases). Tray-client downloads are not Inbox.

Inbox uses the same configuration as the tray client. Open `hitl-inbox.exe` on Windows, or install its MSI. See the [Inbox guide](hitl-mcp-server/README.md#using-inbox).

This README describes the current source tree. Published packages can lag behind it. Android support is in development; an installable APK is not available from this checkout yet.

## Build from source

Install Git, Node.js 24 LTS, Rust stable, and the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/). Windows desktop builds require MSVC C++ Build Tools and WebView2.

```sh
git clone https://github.com/achieveai/HumanInTheLoop.git
cd HumanInTheLoop/hitl-mcp-server
npm ci
npm run build:server
```

Build the tray client from `hitl-mcp-server`:

```sh
npm run build:client
```

Build Inbox on Windows:

```sh
cd inbox
npx --no-install tauri build --bundles msi --ci
```

With no target-directory override, the executable is `hitl-mcp-server/target/release/hitl-inbox.exe`. Its MSI is under `target/release/bundle/msi/`.

**Important:** `npm run build` builds the server and tray client only. Inbox and the archivist require separate commands.

## Guides

- [Detailed setup, usage, configuration, and security](hitl-mcp-server/README.md)
- [Build commands and output paths](hitl-mcp-server/README.md#building-from-source)
- [Tests](hitl-mcp-server/README.md#testing)
- [Publishing and release artifacts](hitl-mcp-server/README.md#publishing-and-release-artifacts)
- [Troubleshooting](hitl-mcp-server/README.md#troubleshooting)
- [Issues](https://github.com/achieveai/HumanInTheLoop/issues)
- [License: GPL-3.0](hitl-mcp-server/LICENSE)
