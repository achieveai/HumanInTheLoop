# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Human-in-the-Loop MCP Server - An MCP (Model Context Protocol) server that enables AI agents to request human input through interactive browser-based dialogs. This allows AI agents to pause execution and ask for guidance at critical decision points rather than making assumptions.

**NPM Package**: `@achieveai/hitl-mcp-server`

## Key Commands

### Development
```bash
cd hitl-mcp-server
npm install              # Install dependencies
npm run build           # Compile TypeScript to JavaScript
npm run dev             # Run in development mode with auto-reload
npm run typecheck       # Type-check without building
```

### Testing
```bash
npm test                # Run Jest unit tests
npm run test:dialog     # Test dialog manager with live browser dialogs
```

### Running the Server
```bash
npm start               # Run compiled server
npx @achieveai/hitl-mcp-server  # Run from npm (no installation)
```

## Architecture

### Core Components

**`src/index.ts`** - Main MCP server implementation
- `HumanInTheLoopServer`: Main server class that implements MCP protocol
- Registers the `ask_human` tool with MCP SDK
- Handles tool requests by delegating to DialogManager
- Uses stdio transport for MCP communication
- Entry point: shebang allows direct execution

**`src/dialog-manager.ts`** - Dialog UI and HTTP server
- `DialogManager`: Express-based HTTP server that serves interactive dialogs
- Generates HTML dialogs with embedded JavaScript for user interaction
- Manages pending dialog state with Promise-based resolution
- Automatically opens browser using the `open` package
- Supports timeouts, multiple choice, custom input ("Other" field)
- Port allocation: Uses port 0 (auto-assign) by default for flexibility

### Data Flow

1. AI agent calls `ask_human` tool via MCP protocol
2. `HumanInTheLoopServer` receives request, validates parameters
3. Request forwarded to `DialogManager.showDialog()`
4. DialogManager creates HTTP endpoint `/dialog/:id` with generated HTML
5. Browser opens automatically to display dialog
6. User submits response via POST `/dialog/:id/response`
7. DialogManager resolves Promise, returns response to MCP server
8. MCP server formats response and sends back to AI agent

### Key Interfaces

```typescript
interface DialogRequest {
  id: string;
  question: string;
  options: DialogOption[];
  allowMultiple: boolean;  // Checkbox vs radio buttons
  allowOther: boolean;     // Show "Other" text field
  context?: string;        // Additional context for user
  timeout?: number;        // Auto-timeout in milliseconds
}

interface DialogResponse {
  id: string;
  selectedValues: string[];  // Array even for single selection
  otherText?: string;        // Custom input or 'SKIPPED'
  timestamp: number;
}
```

## Important Implementation Details

### TypeScript Configuration
- **Module system**: ES Modules (Node16) - Use `.js` extensions in imports
- **Target**: ES2022
- **Output**: `dist/` directory
- Strict mode enabled with comprehensive checks
- All test files excluded from compilation

### Testing Setup
- **Framework**: Jest with ts-jest
- **Mode**: ESM (ECMAScript modules)
- **Test location**: `src/**/__tests__/**/*.ts` or `*.test.ts` files
- **Coverage**: Excludes `*.d.ts`, `test-*.ts` files
- Important: Use `node --experimental-vm-modules` to run Jest (see package.json scripts)

### Express Server Patterns
- Server initialization uses port 0 for auto-assignment (avoids conflicts)
- Lazy initialization: Server starts only when first dialog is needed
- HTML generation uses template literals with XSS protection via `escapeHtml()`
- Static file serving prepared but currently generates all HTML dynamically

### Error Handling
- Dialog timeout returns structured error response (not exception)
- MCP errors use proper ErrorCode enum (MethodNotFound, InvalidParams, InternalError)
- Browser open failures are logged but don't block (user can manually open URL)

### Special Behaviors
- Skip button sends `otherText: 'SKIPPED'` to distinguish from timeout
- Response can be: selection, custom text, skipped, or timed out
- Dialog auto-closes after successful submission (2 second delay)
- Single-select mode still returns array (for consistency)

## NPM Package Configuration

The project is configured for npm publication:
- **Entry point**: `dist/index.js` (compiled)
- **Binary**: `hitl-mcp-server` command
- **Type**: `"module"` (ES modules)
- **Files included**: `dist/`, `config/`, `mcp.json`, `README.md`, `LICENSE`, `example-usage.md`
- **Engines**: Requires Node.js >= 18.0.0

## MCP Client Configuration

The server integrates with MCP clients using stdio transport. Example configs are in `config/` directory for:
- Claude Desktop
- VS Code (Cline extension)
- Cursor IDE

Recommended invocation: `npx -y @achieveai/hitl-mcp-server` (zero-install)

## Development Workflow

When making changes:
1. Edit TypeScript files in `src/`
2. Run `npm run typecheck` to verify types
3. Run `npm test` to verify tests pass
4. Run `npm run build` to compile
5. Test with `npm run test:dialog` for live dialog testing
6. For MCP testing, use `npx @modelcontextprotocol/inspector node dist/index.js`

## Dialog UI Customization

The HTML template in `generateDialogHTML()` is self-contained:
- Embedded CSS with gradient background and animations
- Client-side JavaScript for interaction
- Responsive design with mobile support
- Keyboard shortcuts: Ctrl+Enter in "Other" field submits
