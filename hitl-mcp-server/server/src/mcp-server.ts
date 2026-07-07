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
import type { QuestionMessage, NotificationMessage, HitlToolResponse, SubQuestion, SubAnswer } from './types.js';
import { NtfyTransport } from './ntfy-transport.js';
import { loadConfig } from './config.js';
import { detectRepoContext } from './git-context.js';
import { performSetup, ensureClientRunning } from './setup.js';

const TOOL_NAME = 'AskUserQuestion';
const NOTIFY_TOOL_NAME = 'Notify';
const SETUP_TOOL_NAME = 'setup';
const SERVER_NAME = 'hitl-mcp-server';
const SERVER_VERSION = '2.9.4';

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
          description: `Use this tool when you need to ask the user questions during execution. This tool sends a push notification to ALL of the user's devices simultaneously — phone, laptop, desktop — so the human can respond from whichever device is most convenient, even when they have stepped away from the terminal. The answer is relayed back to you instantly.

This allows you to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take
5. Reach the user even when they are AFK, on a different machine, or checking their phone — unlike terminal-bound prompts, this tool is never missed

Usage notes:
- Users will always be able to provide custom text input via "Additional Context"
- Use allowMultiple: true to allow multiple answers to be selected for a question
- If you recommend a specific option, add "(Recommended)" to the label
- Fill in the "context" field with what project/work you are doing — this helps the human understand the situation across devices
- Provide clear, specific options for the human to choose from

Preview feature:
Use the optional "preview" field on options when presenting concrete artifacts that users need to visually compare:
- ASCII mockups of UI layouts or components
- Code snippets showing different implementations
- Diagram variations
- Configuration examples
Preview content is rendered as markdown in a side panel. Do not use previews for simple preference questions where labels and descriptions suffice.

Batch mode:
Use the "questions" array (up to 4 sub-questions) to ask multiple related questions in a single dialog, reducing interruptions.

WHEN TO USE (err on the side of asking — if in doubt, ask):
• You have even slight uncertainty about what the user wants
• You need clarification on ambiguous requirements or instructions
• Multiple valid approaches exist and you're unsure which to choose
• A decision could have significant consequences (architecture, data model, API design)
• You need confirmation before critical, destructive, or irreversible actions
• You need additional context not provided in your instructions
• You are about to make a design choice that affects future work
• You want to confirm scope — what's in vs. out of a feature
• You're choosing between libraries, frameworks, or tools
• You're unsure about naming conventions, API shape, or data formats
• You need to know deployment targets, environments, or constraints
• You're deciding on error handling strategy (retry, fail, ignore)
• You're about to refactor code and want to confirm the approach
• You need to prioritize between multiple tasks or bugs
• You want to verify edge case behavior (limits, defaults, empty states)
• You're making security or permissions decisions
• You need sign-off on UX copy, labels, or user-facing text
• You want to confirm test coverage expectations
• You're unsure whether to fix a pre-existing issue you discovered
• You need credentials, API keys, or environment-specific values
• You want to present a progress update and get course correction

IMPORTANT: When in doubt, ASK. Getting human input ensures accuracy and saves time. This tool is the most reliable way to get human input — it works across all devices simultaneously.`,
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
                    preview: {
                      type: 'string',
                      description: 'Optional markdown content shown in a side panel when this option is focused. Use for ASCII mockups, code snippets, or detailed comparisons.',
                    },
                  },
                  required: ['label', 'value'],
                },
                minItems: 1,
              },
              questions: {
                type: 'array',
                description: 'Array of sub-questions for batch mode (up to 4). Mutually exclusive with question+options.',
                items: {
                  type: 'object',
                  properties: {
                    question: {
                      type: 'string',
                      description: 'The sub-question text (supports markdown). If omitted, falls back to the header text.',
                    },
                    header: {
                      type: 'string',
                      description: 'Short chip label shown above the question (~12 chars max)',
                    },
                    options: {
                      type: 'array',
                      description: 'Selectable options for this sub-question',
                      items: {
                        type: 'object',
                        properties: {
                          label: { type: 'string' },
                          value: { type: 'string' },
                          description: { type: 'string' },
                          preview: {
                            type: 'string',
                            description: 'Optional markdown shown in a side panel when this option is focused',
                          },
                        },
                        required: ['label', 'value'],
                      },
                      minItems: 1,
                    },
                    allowMultiple: { type: 'boolean', default: false },
                    allowOther: { type: 'boolean', default: true },
                  },
                  required: ['options'],
                },
                minItems: 1,
                maxItems: 4,
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
                description: 'Timeout in milliseconds (default: 3600000 = 1 hour)',
                minimum: 1000,
                maximum: 86400000,
              },
            },
            required: ['context'],
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
        {
          name: NOTIFY_TOOL_NAME,
          description:
            'Send a notification to the human without waiting for a response. ' +
            'Use this for progress updates, status messages, or any information the human should see. ' +
            'The notification appears on all of the user\'s devices and can be dismissed. ' +
            'Unlike AskUserQuestion, this tool returns immediately — it does NOT block.',
          inputSchema: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description: 'Short title for the notification (e.g. "Build Complete", "Tests Passing")',
              },
              body: {
                type: 'string',
                description: 'Notification body text. Supports markdown.',
              },
              context: {
                type: 'string',
                description: 'Optional context about what triggered this notification.',
              },
            },
            required: ['title', 'body'],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
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

      // Handle notify tool (fire-and-forget)
      if (request.params.name === NOTIFY_TOOL_NAME) {
        const args = request.params.arguments as Record<string, unknown>;

        if (!args.title || !args.body) {
          throw new McpError(ErrorCode.InvalidParams, 'Missing required parameters: title and body');
        }

        try {
          ensureClientRunning(SERVER_DIR);

          const notification: NotificationMessage = {
            type: 'notification',
            messageId: uuidv4(),
            timestamp: Date.now(),
            title: args.title as string,
            body: args.body as string,
            context: (args.context as string) || undefined,
          };

          await this.transport.publish(notification);

          return {
            content: [{ type: 'text', text: JSON.stringify({ success: true, messageId: notification.messageId }) }],
          };
        } catch (error) {
          throw new McpError(
            ErrorCode.InternalError,
            `Failed to send notification: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      }

      if (request.params.name !== TOOL_NAME) {
        throw new McpError(ErrorCode.MethodNotFound, `Tool not found: ${request.params.name}`);
      }

      const args = request.params.arguments as Record<string, unknown>;

      const hasSingleQuestion = args.question && Array.isArray(args.options) && args.options.length > 0;
      const hasBatchQuestions = Array.isArray(args.questions) && (args.questions as unknown[]).length > 0;

      if (!args.context) {
        throw new McpError(ErrorCode.InvalidParams, 'Missing required parameter: context');
      }
      if (!hasSingleQuestion && !hasBatchQuestions) {
        throw new McpError(
          ErrorCode.InvalidParams,
          'Provide either question+options for a single question, or a questions array for batch mode'
        );
      }

      try {
        // Auto-launch client if not running
        ensureClientRunning(SERVER_DIR);

        const repo = detectRepoContext();

        const mapOption = (opt: { label: string; value: string; description?: string; preview?: string }) => ({
          label: opt.label || opt.value,
          value: opt.value,
          description: opt.description,
          preview: opt.preview,
        });

        const batchQuestions = hasBatchQuestions
          ? (args.questions as Array<Partial<SubQuestion> & Pick<SubQuestion, 'options'>>).map((sq) => ({
              question: sq.question || sq.header || 'Please choose an option:',
              header: sq.header,
              options: sq.options.map(mapOption),
              allowMultiple: sq.allowMultiple ?? false,
              allowOther: sq.allowOther ?? true,
            }))
          : undefined;

        const questionMsg: QuestionMessage = {
          type: 'question',
          messageId: uuidv4(),
          timestamp: Date.now(),
          repo,
          context: args.context as string,
          // For batch mode these are placeholders; client uses questions array instead
          question: hasBatchQuestions ? '' : (args.question as string),
          options: hasBatchQuestions
            ? []
            : (args.options as Array<{ label: string; value: string; description?: string; preview?: string }>).map(mapOption),
          allowMultiple: hasBatchQuestions ? false : (args.allowMultiple as boolean) !== false,
          allowOther: hasBatchQuestions ? true : (args.allowOther as boolean) !== false,
          timeout: (args.timeout as number) || 3600000,
          questions: batchQuestions,
        };

        console.error(`Publishing question ${questionMsg.messageId} to ntfy...`);
        await this.transport.publish(questionMsg);
        console.error('Question published. Waiting for answer...');

        // Send periodic progress notifications to prevent MCP client timeout.
        // Each progress notification resets the client's countdown timer.
        const HEARTBEAT_INTERVAL_MS = 15_000;
        const progressToken = extra?._meta?.progressToken;
        let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
        let progressCount = 0;

        if (progressToken !== undefined) {
          heartbeatTimer = setInterval(async () => {
            progressCount++;
            try {
              await extra.sendNotification({
                method: 'notifications/progress',
                params: {
                  progressToken,
                  progress: progressCount,
                  total: 0,
                  message: 'Waiting for human response...',
                },
              });
            } catch {
              // Client may have disconnected; ignore
            }
          }, HEARTBEAT_INTERVAL_MS);
        }

        let answer;
        try {
          answer = await this.transport.waitForAnswer(
            questionMsg.messageId,
            questionMsg.timeout
          );
        } finally {
          if (heartbeatTimer) clearInterval(heartbeatTimer);
        }

        console.error(`Answer received from ${answer.respondedFrom}`);

        // Strip (RECOMMENDED) markers from values
        const stripRecommended = (v: string) => v.replace(/\s*\(RECOMMENDED\)\s*/gi, '').trim();

        // Handle batch response
        if (answer.subAnswers && answer.subAnswers.length > 0) {
          const cleanedAnswers: SubAnswer[] = answer.subAnswers.map((sa) => ({
            ...sa,
            selectedValues: sa.selectedValues.map(stripRecommended),
          }));
          const batchResult: HitlToolResponse = {
            success: true,
            timestamp: answer.timestamp,
            respondedFrom: answer.respondedFrom,
            responseType: 'selection',
            answers: cleanedAnswers,
          };
          return {
            content: [{ type: 'text', text: JSON.stringify(batchResult, null, 2) }],
          };
        }

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
