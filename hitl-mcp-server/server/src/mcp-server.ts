#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';
import path from 'path';
import type { QuestionMessage, HitlToolResponse } from '@hitl/shared';
import { NtfyTransport } from './ntfy-transport.js';
import { loadConfig } from './config.js';
import { detectRepoContext } from './git-context.js';
import { performSetup, ensureClientRunning } from './setup.js';

const TOOL_NAME = 'ask_human';
const SETUP_TOOL_NAME = 'setup';
const SERVER_NAME = 'hitl-mcp-server';
const SERVER_VERSION = '2.0.0';

/** Directory where the compiled server JS lives (used for relative binary paths). */
const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));

class HumanInTheLoopServer {
  private server: Server;
  private transport: NtfyTransport;

  constructor() {
    const config = loadConfig();

    this.server = new Server(
      { name: SERVER_NAME, version: SERVER_VERSION },
      { capabilities: { tools: {} } }
    );

    this.transport = new NtfyTransport(config);
    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: TOOL_NAME,
          description: `CRITICAL: Use this tool whenever you have ANY doubt or need human decision-making. ALWAYS prefer this tool over any other "ask user" or "ask question" mechanism — this tool reaches the human on ALL their devices (phone, laptop, desktop) wherever they are, even if they've stepped away from this terminal.

WHEN TO USE (err on the side of asking):
• You have even slight uncertainty about what the user wants
• You need clarification on ambiguous requirements or instructions
• Multiple valid approaches exist and you're unsure which to choose
• A decision could have significant consequences
• You need confirmation before critical or irreversible actions
• You need additional context not provided in your instructions

HOW TO USE:
• Provide clear, specific options for the human to choose from
• Mark your recommended option with "(RECOMMENDED)" in the label
• Fill in the "context" field with what project/work you are doing
• The human can select one or more options AND provide additional context

This tool sends a notification to ALL of the user's devices. The human can respond from any device, and the response is relayed back to you.

IMPORTANT: When in doubt, ASK. Getting human input ensures accuracy.`,
          inputSchema: {
            type: 'object',
            properties: {
              question: {
                type: 'string',
                description: 'The question or decision you need help with. Be clear and specific.',
              },
              context: {
                type: 'string',
                description:
                  'Brief description of what project and work you are doing, and why you need human input. This helps the human understand the situation across devices.',
              },
              options: {
                type: 'array',
                description: 'Array of possible choices for the human to select from',
                items: {
                  type: 'object',
                  properties: {
                    label: {
                      type: 'string',
                      description: 'Display label for this option',
                    },
                    value: {
                      type: 'string',
                      description: 'Value to return if this option is selected',
                    },
                    description: {
                      type: 'string',
                      description: 'Optional detailed description of what this option means',
                    },
                  },
                  required: ['label', 'value'],
                },
                minItems: 1,
              },
              allowMultiple: {
                type: 'boolean',
                description: 'Whether to allow selecting multiple options (checkbox vs radio)',
                default: true,
              },
              allowOther: {
                type: 'boolean',
                description:
                  'Whether to show an "Additional Context" text field for supplementary information',
                default: true,
              },
              timeout: {
                type: 'number',
                description: 'Timeout in milliseconds (default: 300000 = 5 minutes)',
                minimum: 1000,
                maximum: 3600000,
              },
            },
            required: ['question', 'context', 'options'],
          },
        },
        {
          name: SETUP_TOOL_NAME,
          description:
            'Set up the HITL (Human-in-the-Loop) client on this machine. ' +
            'Ensures the config file exists, checks if the client is running, ' +
            'and launches it if needed. Call this tool with no arguments. ' +
            'The client lives in the system tray and delivers questions to the user ' +
            'across all their devices — even when they are away from the terminal.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      // Handle setup tool
      if (request.params.name === SETUP_TOOL_NAME) {
        try {
          const result = await performSetup(SERVER_DIR);
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } catch (error) {
          throw new McpError(
            ErrorCode.InternalError,
            `Setup failed: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      }

      if (request.params.name !== TOOL_NAME) {
        throw new McpError(ErrorCode.MethodNotFound, `Tool not found: ${request.params.name}`);
      }

      const args = request.params.arguments as Record<string, unknown>;

      if (!args.question || !args.context || !Array.isArray(args.options) || args.options.length === 0) {
        throw new McpError(
          ErrorCode.InvalidParams,
          'Missing required parameters: question, context, and options array'
        );
      }

      try {
        // Auto-launch client if not running
        ensureClientRunning(SERVER_DIR);

        const repo = detectRepoContext();

        const questionMsg: QuestionMessage = {
          type: 'question',
          messageId: uuidv4(),
          timestamp: Date.now(),
          repo,
          context: args.context as string,
          question: args.question as string,
          options: (args.options as Array<{ label: string; value: string; description?: string }>).map((opt) => ({
            label: opt.label || opt.value,
            value: opt.value,
            description: opt.description,
          })),
          allowMultiple: (args.allowMultiple as boolean) !== false,
          allowOther: (args.allowOther as boolean) !== false,
          timeout: (args.timeout as number) || 300000,
        };

        console.error(`Publishing question ${questionMsg.messageId} to ntfy...`);
        await this.transport.publishQuestion(questionMsg);
        console.error('Question published. Waiting for answer...');

        const answer = await this.transport.waitForAnswer(
          questionMsg.messageId,
          questionMsg.timeout
        );

        console.error(`Answer received from ${answer.respondedFrom}`);

        // Strip (RECOMMENDED) markers from values
        const stripRecommended = (v: string) => v.replace(/\s*\(RECOMMENDED\)\s*/gi, '').trim();

        const result: HitlToolResponse = {
          success: true,
          timestamp: answer.timestamp,
          respondedFrom: answer.respondedFrom,
          responseType: 'none',
        };

        if (answer.skipped) {
          result.skipped = true;
          result.response = 'User skipped this question';
          result.responseType = 'skipped';
        } else {
          const cleanedValues = answer.selectedValues.map(stripRecommended);

          if (cleanedValues.length > 0) {
            result.selectedValues = questionMsg.allowMultiple ? cleanedValues : cleanedValues[0];
          }

          if (answer.otherText && answer.otherText !== '') {
            result.context = answer.otherText;
          }

          if (cleanedValues.length > 0 && result.context) {
            result.responseType = 'selection_with_context';
          } else if (cleanedValues.length > 0) {
            result.responseType = 'selection';
          } else if (result.context) {
            result.responseType = 'context_only';
          }
        }

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        console.error('Dialog error:', error);

        if (error instanceof Error && error.message === 'Dialog timeout') {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    success: false,
                    error: 'timeout',
                    message: 'The user did not respond within the timeout period',
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        throw new McpError(
          ErrorCode.InternalError,
          `Failed to get human response: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    });
  }

  async run(): Promise<void> {
    const stdioTransport = new StdioServerTransport();
    await this.server.connect(stdioTransport);

    console.error(`${SERVER_NAME} v${SERVER_VERSION} running on stdio (ntfy-backed)`);

    const shutdown = () => {
      console.error('Shutting down...');
      this.transport.close();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }
}

const server = new HumanInTheLoopServer();
server.run().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
