#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError
} from '@modelcontextprotocol/sdk/types.js';
import { DialogManager, DialogOption } from './dialog-manager.js';
import { v4 as uuidv4 } from 'uuid';

const TOOL_NAME = 'ask_human';
const SERVER_NAME = 'hitl-mcp-server';
const SERVER_VERSION = '1.0.0';

class HumanInTheLoopServer {
  private server: Server;
  private dialogManager: DialogManager;

  constructor() {
    this.server = new Server(
      {
        name: SERVER_NAME,
        version: SERVER_VERSION,
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.dialogManager = new DialogManager();
    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: TOOL_NAME,
          description: `CRITICAL: Use this tool whenever you have ANY doubt or need human decision-making. This tool is ESSENTIAL for:

WHEN TO USE (err on the side of asking):
• You have even slight uncertainty about what the user wants
• You need clarification on ambiguous requirements or instructions
• The user explicitly told you to ask for their input on decisions
• Multiple valid approaches exist and you're unsure which to choose
• A decision could have significant consequences
• You're about to make assumptions that might be wrong
• You need confirmation before critical or irreversible actions
• You need additional context not provided in your instructions

HOW TO USE:
• Provide clear, specific options for the human to choose from
• Think carefully about which option you would recommend and mark it with "(RECOMMENDED)" in the label
  Example: { label: "PostgreSQL (RECOMMENDED)", value: "postgres", description: "Best for complex queries" }
• The human can select one or more options AND provide additional context
• The "(RECOMMENDED)" marker helps guide the user but won't appear in the returned value

This tool opens an interactive browser dialog with a pleasant notification sound. The human can select options and optionally provide additional context to guide your next steps.

IMPORTANT: When in doubt, ASK. Using this tool is far better than making incorrect assumptions. Getting human input ensures accuracy and alignment with user expectations.`,
          inputSchema: {
            type: 'object',
            properties: {
              question: {
                type: 'string',
                description: 'The question or decision you need help with. Be clear and specific.'
              },
              options: {
                type: 'array',
                description: 'Array of possible choices for the human to select from',
                items: {
                  type: 'object',
                  properties: {
                    label: {
                      type: 'string',
                      description: 'Display label for this option'
                    },
                    value: {
                      type: 'string',
                      description: 'Value to return if this option is selected'
                    },
                    description: {
                      type: 'string',
                      description: 'Optional detailed description of what this option means'
                    }
                  },
                  required: ['label', 'value']
                },
                minItems: 1
              },
              allowMultiple: {
                type: 'boolean',
                description: 'Whether to allow selecting multiple options (checkbox vs radio)',
                default: true
              },
              allowOther: {
                type: 'boolean',
                description: 'Whether to show an "Additional Context" text field where the user can provide supplementary information alongside their selection(s)',
                default: true
              },
              context: {
                type: 'string',
                description: 'Additional context to help the human understand the situation'
              },
              timeout: {
                type: 'number',
                description: 'Timeout in milliseconds (default: no timeout)',
                minimum: 1000,
                maximum: 3600000
              }
            },
            required: ['question', 'options']
          }
        }
      ]
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name !== TOOL_NAME) {
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Tool not found: ${request.params.name}`
        );
      }

      const args = request.params.arguments as any;
      
      if (!args.question || !Array.isArray(args.options) || args.options.length === 0) {
        throw new McpError(
          ErrorCode.InvalidParams,
          'Missing required parameters: question and options array'
        );
      }

      try {
        const dialogOptions: DialogOption[] = args.options.map((opt: any) => ({
          label: opt.label || opt.value,
          value: opt.value,
          description: opt.description
        }));

        const response = await this.dialogManager.showDialog({
          id: uuidv4(),
          question: args.question,
          options: dialogOptions,
          allowMultiple: args.allowMultiple !== false,
          allowOther: args.allowOther !== false,
          context: args.context,
          timeout: args.timeout
        });

        // Helper function to strip (RECOMMENDED) markers from values
        const stripRecommended = (value: string): string => {
          return value.replace(/\s*\(RECOMMENDED\)\s*/gi, '').trim();
        };

        let result: any = {
          success: true,
          timestamp: response.timestamp
        };

        if (response.otherText === 'SKIPPED') {
          result.skipped = true;
          result.response = 'User skipped this question';
          result.responseType = 'skipped';
        } else {
          // Clean the selected values
          const cleanedValues = response.selectedValues.map(stripRecommended);

          // Include selected values if any
          if (cleanedValues.length > 0) {
            result.selectedValues = args.allowMultiple ? cleanedValues : cleanedValues[0];
          }

          // Include context if provided
          if (response.otherText && response.otherText !== '') {
            result.context = response.otherText;
          }

          // Determine response type
          if (cleanedValues.length > 0 && result.context) {
            result.responseType = 'selection_with_context';
          } else if (cleanedValues.length > 0) {
            result.responseType = 'selection';
          } else if (result.context) {
            result.responseType = 'context_only';
          } else {
            result.responseType = 'none';
          }
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      } catch (error) {
        console.error('Dialog error:', error);
        
        if (error instanceof Error && error.message === 'Dialog timeout') {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  error: 'timeout',
                  message: 'The user did not respond within the timeout period'
                }, null, 2)
              }
            ]
          };
        }
        
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to show dialog: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    });
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.dialogManager.initialize();
    await this.server.connect(transport);
    
    console.error(`${SERVER_NAME} v${SERVER_VERSION} running on stdio`);

    process.on('SIGINT', async () => {
      await this.cleanup();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      await this.cleanup();
      process.exit(0);
    });
  }

  private async cleanup(): Promise<void> {
    console.error('Shutting down...');
    await this.dialogManager.close();
  }
}

const server = new HumanInTheLoopServer();
server.run().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});