# Human-in-the-Loop MCP Server

This repository contains the Human-in-the-Loop MCP Server implementation for enabling AI agents to request human input through interactive dialogs.

## 🛠️ What Agents Can Do

| Tool | Purpose |
|---|---|
| `AskUserQuestion` | Ask a question (or up to 4 at once) and block until a human answers on any of their devices |
| `ReviewPlan` | Send a markdown plan for **line-anchored review** — the human comments on specific line ranges and returns a verdict; re-running it shows a diff against what they reviewed last time |
| `Notify` | Push a status update to every device without blocking |
| `setup` | Create the config and launch the tray client on this machine |

Blocking calls emit progress heartbeats every 15 seconds, but **how long they may block is decided by your MCP host**: hosts that do not opt into `resetTimeoutOnProgress` cancel the request after the SDK default of 60 seconds. See [Blocking and host timeouts](./hitl-mcp-server/README.md#blocking-and-host-timeouts).

## 📦 Package Information

The main package is available on npm as:
```
@achieveai/hitl-mcp-server
```

## 📚 Documentation

For complete documentation, installation instructions, and usage examples, please see:

**[hitl-mcp-server/README.md](./hitl-mcp-server/README.md)**

## 🚀 Quick Start

```bash
# Install globally
npm install -g @achieveai/hitl-mcp-server

# Or run directly with npx (no installation required)
npx @achieveai/hitl-mcp-server
```

## 🔧 Development

To work on this project locally:

```bash
# Clone the repository
git clone https://github.com/achieveai/HumanInTheLoop.git
cd HumanInTheLoop/hitl-mcp-server

# Install dependencies
npm install

# Build the project
npm run build

# Run tests
npm test
```

## 📝 License

GPL-3.0 - See [LICENSE](./hitl-mcp-server/LICENSE) file for details.

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 🔗 Links

- [NPM Package](https://www.npmjs.com/package/@achieveai/hitl-mcp-server)
- [GitHub Repository](https://github.com/achieveai/HumanInTheLoop)
- [Issue Tracker](https://github.com/achieveai/HumanInTheLoop/issues)

---

Built with ❤️ by [MCQdb LLC](https://achieve.ai)