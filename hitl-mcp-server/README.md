# Human In The Loop MCP Server

A Model Context Protocol (MCP) server that enables LLM agents to request human input through interactive dialog boxes. This tool provides a seamless way for AI agents to ask for clarification, make decisions with human guidance, and handle ambiguous situations.

## Features

- **Interactive Dialog UI**: Opens a browser-based dialog for user interaction
- **Multiple Choice Questions**: Support for both single and multiple selection
- **Custom Input**: "Other" field for free-text responses
- **Cross-Platform**: Works on Windows, macOS, and Linux
- **Timeout Support**: Configurable timeouts for time-sensitive decisions
- **STDIO Transport**: Easy integration with Claude Desktop and other MCP clients

## Installation

### Prerequisites

- Node.js 18+ and npm
- A browser (for displaying dialogs)

### From Source

```bash
# Clone the repository
git clone <repository-url>
cd hitl-mcp-server

# Install dependencies
npm install

# Build the TypeScript code
npm run build

# Test the installation
npm run dev
```

### Global Installation

```bash
# Build first
npm run build

# Install globally
npm install -g .

# Now you can run it from anywhere
hitl-mcp-server
```

## Configuration

Pre-configured examples are available in the `config/` directory for different MCP clients.

### Claude Desktop Configuration

Add the server to your Claude Desktop config file:

**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Linux**: `~/.config/claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "human-in-the-loop": {
      "command": "node",
      "args": ["D:\\Source\\repos\\Hitl_MCP\\hitl-mcp-server\\dist\\index.js"],
      "env": {
        "NODE_ENV": "production"
      }
    }
  }
}
```

### VS Code Configuration

Create `.vscode/mcp.json` in your workspace:

```json
{
  "mcpServers": {
    "human-in-the-loop": {
      "command": "npx",
      "args": ["-y", "@hitl/mcp-server"],
      "env": {
        "NODE_ENV": "production"
      }
    }
  }
}
```

### Cursor IDE Configuration

Add to your Cursor settings:

```json
{
  "mcpServers": {
    "human-in-the-loop": {
      "name": "Human In The Loop",
      "command": "node",
      "args": ["./dist/index.js"],
      "cwd": "D:\\Source\\repos\\Hitl_MCP\\hitl-mcp-server",
      "transport": "stdio",
      "autoStart": false
    }
  }
}
```

### NPM Global Installation

```bash
# Install globally from npm (when published)
npm install -g @hitl/mcp-server

# Then use in any config:
{
  "mcpServers": {
    "human-in-the-loop": {
      "command": "hitl-mcp-server"
    }
  }
}
```

## Usage

Once configured, the AI agent can use the `ask_human` tool to request input:

### Example: Single Choice

```javascript
{
  "question": "Which database should I use for this project?",
  "options": [
    {
      "label": "PostgreSQL",
      "value": "postgres",
      "description": "Robust relational database with advanced features"
    },
    {
      "label": "MongoDB",
      "value": "mongo",
      "description": "Flexible document database for unstructured data"
    },
    {
      "label": "SQLite",
      "value": "sqlite",
      "description": "Lightweight embedded database"
    }
  ],
  "allowMultiple": false,
  "allowOther": true,
  "context": "This is for a medium-scale web application with complex queries"
}
```

### Example: Multiple Choice

```javascript
{
  "question": "Which files should I include in the commit?",
  "options": [
    {
      "label": "src/index.ts",
      "value": "index"
    },
    {
      "label": "src/utils.ts",
      "value": "utils"
    },
    {
      "label": "README.md",
      "value": "readme"
    }
  ],
  "allowMultiple": true,
  "allowOther": false,
  "context": "Several files have been modified"
}
```

### Example: With Timeout

```javascript
{
  "question": "Should I proceed with the deployment?",
  "options": [
    {
      "label": "Yes, deploy now",
      "value": "yes"
    },
    {
      "label": "No, cancel",
      "value": "no"
    }
  ],
  "allowMultiple": false,
  "allowOther": false,
  "timeout": 30000  // 30 seconds
}
```

## Response Format

The tool returns a JSON response:

```javascript
{
  "success": true,
  "timestamp": 1703001234567,
  "response": "selected_value",  // or array for multiple selection
  "responseType": "selection"    // or "custom" for other text, "none" if skipped
}
```

## Testing

### Run Unit Tests

```bash
npm test
```

### Test Dialog Manager

```bash
npm run build
node dist/test-client.js
```

This will open test dialogs to verify the UI is working correctly.

### Manual Testing with MCP Inspector

You can use the MCP Inspector tool to test the server:

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

## Development

### Project Structure

```
hitl-mcp-server/
├── src/
│   ├── index.ts           # Main MCP server implementation
│   ├── dialog-manager.ts  # Dialog UI and HTTP server
│   └── test-client.ts     # Test client for dialog manager
├── dist/                  # Compiled JavaScript (after build)
├── package.json
├── tsconfig.json
└── README.md
```

### Available Scripts

- `npm run build` - Compile TypeScript to JavaScript
- `npm run dev` - Run in development mode with auto-reload
- `npm test` - Run unit tests
- `npm run typecheck` - Check TypeScript types without building

## Why Use This Tool?

LLM agents often encounter situations requiring human judgment:

1. **Ambiguous Requirements**: When instructions are unclear or contradictory
2. **Critical Decisions**: Before performing irreversible actions
3. **Multiple Valid Approaches**: When several solutions are equally valid
4. **Missing Context**: When additional information is needed
5. **Subjective Choices**: Design decisions, naming conventions, etc.

This tool ensures AI agents can gracefully handle these situations by requesting human input rather than making assumptions or failing silently.

## Troubleshooting

### Dialog doesn't open

- Check if port 3000-5000 range is available
- Ensure your default browser is properly configured
- Check the server logs for error messages

### Timeout errors

- Increase the timeout value in your request
- Ensure the dialog window has focus

### Server won't start

- Check if another instance is already running
- Verify Node.js version is 18 or higher
- Run `npm install` to ensure all dependencies are installed

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.