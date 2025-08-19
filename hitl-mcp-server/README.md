# Human In The Loop MCP Server

A Model Context Protocol (MCP) server that bridges the gap between AI autonomy and human oversight by enabling LLM agents to request human input at critical decision points.

## What This Tool Does

This MCP server allows AI agents like Claude to pause their execution and ask humans for guidance through interactive browser-based dialogs. Instead of making assumptions or failing when faced with ambiguity, AI agents can now gracefully request human input and continue with confidence.

## Real-World Use Cases

### 1. **Code Generation Decisions**
When generating code, the AI can ask:
- "Which framework should I use: React, Vue, or Angular?"
- "Should I implement this with TypeScript or JavaScript?"
- "Which testing framework do you prefer?"

### 2. **Deployment & Operations**
- "Ready to deploy to production? I've run all tests."
- "Should I rollback the deployment? Errors detected."
- "Which environment: staging or production?"

### 3. **Data Processing**
- "Found 1000 duplicate records. Delete all, keep first, or review manually?"
- "Which columns should I include in the export?"
- "Normalize the data using method A (faster) or B (more accurate)?"

### 4. **Content & Documentation**
- "Which tone for the documentation: formal, casual, or technical?"
- "Include code examples in the README?"
- "Which sections are most important for your users?"

### 5. **Git Operations**
- "Which files should I include in this commit?"
- "Merge conflict detected. Keep theirs, ours, or manual review?"
- "Create a new branch or commit to main?"

## What to Expect

### For Developers
- **Reduced Errors**: AI agents won't make incorrect assumptions about your preferences
- **Better Control**: Maintain oversight of critical decisions while letting AI handle the implementation
- **Improved Workflow**: AI can complete complex multi-step tasks with human guidance at key points
- **Time Savings**: Let AI do the work while you just make the important decisions

### For AI Agents
- **Clear Decision Points**: No more guessing what the user wants
- **Graceful Handling**: Ambiguous situations become opportunities for clarification
- **Better Results**: Human input ensures the output matches expectations
- **Continuous Workflow**: Complete tasks without stopping for every small decision

## Core Features

- **Browser-Based Dialogs**: Clean, accessible UI that opens automatically
- **Multiple Choice Support**: Single or multi-select options with descriptions
- **Custom Input**: "Other" field for responses not in the list
- **Timeout Support**: Auto-dismiss dialogs after specified time
- **Cross-Platform**: Works on Windows, macOS, and Linux
- **Zero Configuration**: Works out of the box with sensible defaults

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
      "args": ["-y", "@achieveai/hitl-mcp-server"],
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
# Install globally from npm
npm install -g @achieveai/hitl-mcp-server

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

## Why This Tool Matters

### The Problem
AI agents are powerful but often encounter situations where they need human judgment:
- Ambiguous requirements that could be interpreted multiple ways
- Critical decisions that could have significant consequences
- Subjective choices about style, approach, or priorities
- Missing context that only the human user possesses

### The Solution
This tool creates a seamless communication channel between AI and humans:
- **AI Autonomy**: The agent continues working independently until it needs input
- **Human Control**: You maintain oversight of important decisions
- **Efficient Workflow**: No need to micromanage - only intervene when necessary
- **Better Outcomes**: Combine AI efficiency with human judgment

### Expected Benefits

1. **Increased Productivity**
   - Let AI handle implementation while you focus on decisions
   - Batch multiple tasks with decision points
   - Reduce back-and-forth clarifications

2. **Improved Accuracy**
   - No more AI guessing your preferences
   - Catch potential issues before they happen
   - Ensure outputs match your expectations

3. **Enhanced Trust**
   - Know that AI will ask before making critical changes
   - Review and approve important decisions
   - Maintain control while leveraging AI capabilities

4. **Seamless Integration**
   - Works with Claude Desktop, Cursor, VS Code, and other MCP clients
   - No complex setup or configuration required
   - Natural integration into existing AI workflows

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

## Security & Privacy

- All dialogs run locally on your machine
- No data is sent to external servers
- Dialog server only accepts connections from localhost
- Temporary server instances are created per request

## License

GPL-3.0

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.