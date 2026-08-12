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
import { realpathSync } from 'fs';
import path from 'path';
import type {
  QuestionMessage,
  NotificationMessage,
  HitlToolResponse,
  SubQuestion,
  SubAnswer,
  AttachmentRef,
  PlanReviewMessage,
  PlanReviewBody,
  PlanReviewResponseMessage,
  PlanReviewResponseBody,
  PlanReviewAckMessage,
  CancelReviewMessage,
  HitlConfig,
  PlanVerdict,
} from './types.js';
import { PROTOCOL_VERSION } from './types.js';
import { NtfyTransport, AttachmentExpiredError } from './ntfy-transport.js';
import { loadConfig } from './config.js';
import { detectRepoContext } from './git-context.js';
import { performSetup, ensureClientRunning } from './setup.js';
import { SERVER_VERSION } from './version.js';
import { readPlanFile, PlanFileError } from './plan-file.js';
import { resolvePlanIdentity, prepareRevision } from './snapshot-store.js';
import { resolveBaseline, buildPlanDiff } from './plan-diff.js';
import { encodePayload, decodePayload, PayloadDecodeError } from './payload.js';
import type { ReviewPlanResult } from './plan-review.js';
import { parseVerdict, normalizeResponseBody, ReviewResponseError } from './plan-review.js';

const TOOL_NAME = 'AskUserQuestion';
const NOTIFY_TOOL_NAME = 'Notify';
const SETUP_TOOL_NAME = 'setup';
const REVIEW_TOOL_NAME = 'ReviewPlan';
const SERVER_NAME = 'hitl-mcp-server';

/** Interval between progress notifications that keep a blocked MCP call alive. */
const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * How long to keep listening for a second device's submission after a review
 * has already been answered, so the loser is told rather than left hanging.
 */
const LATE_RESPONSE_WINDOW_MS = 45_000;

/** Directory where the compiled server JS lives (used for relative binary paths). */
const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Best-effort message for an unknown thrown value, for ack reasons and logs. */
function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The SDK's per-request context: progress token, sendNotification, abort signal. */
type RequestExtra = Parameters<Parameters<Server['setRequestHandler']>[1]>[1];

export class HumanInTheLoopServer {
  private server: Server;
  private transport: NtfyTransport;
  private config: HitlConfig;
  /** reviewIds still waiting on a human, so a graceful exit can release them (D-3). */
  private outstandingReviews = new Set<string>();

  /** `config` is injectable so a test can construct a server without a real ~/.hitl. */
  constructor(config: HitlConfig = loadConfig()) {
    this.config = config;

    this.server = new Server(
      { name: SERVER_NAME, version: SERVER_VERSION },
      { capabilities: { tools: {} } }
    );

    this.transport = new NtfyTransport(this.config);
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
        {
          name: REVIEW_TOOL_NAME,
          description: `Get line-anchored human review of an implementation plan you have written to a markdown file.

The plan opens as a two-pane review window on every device the user has subscribed — phone, laptop, desktop — so they can review it wherever they are. They select line ranges, attach comments to them, and return a verdict. This call blocks until they submit.

Use this instead of pasting a plan into AskUserQuestion whenever you want feedback on specific lines rather than a yes/no. Typical moments: after drafting an implementation plan, a migration sequence, an architecture proposal, or a refactor outline.

IMPORTANT — do not modify the file while this call is blocked. The returned snapshotHash identifies the exact content the human reviewed; if you rewrite the file mid-review, their approval applies to text that no longer exists.

Revisions: call it again with the same file after making the requested changes. The user sees a diff against what they reviewed last time rather than the whole plan again, and the revision number increments.

Returns JSON: { success, timestamp, respondedFrom, verdict, overallFeedback, inlineComments[], revision, isNewPlan, snapshotHash }.
- verdict is one of: approved | changes_requested | rejected | skipped | cancelled
- inlineComments are { path, startLine, endLine, side, comment }, stably sorted, with line numbers in the source-line space of the file you passed
- changes_requested and rejected always carry either overallFeedback or at least one inline comment

Blocking past 60 seconds requires the calling MCP host to opt into resetTimeoutOnProgress; this server emits progress heartbeats but cannot enforce the host's timeout.`,
          inputSchema: {
            type: 'object',
            properties: {
              filePath: {
                type: 'string',
                description:
                  'Absolute or cwd-relative path to the markdown plan file (.md or .markdown, up to 1 MB).',
              },
              context: {
                type: 'string',
                description:
                  'Brief description of what project and work you are doing. This helps the human understand the situation across devices.',
              },
              summary: {
                type: 'string',
                description:
                  'Optional short prose framing shown above the document — what changed since last time, or what you most want feedback on.',
              },
            },
            required: ['filePath', 'context'],
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
          this.requireClient();

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

      if (request.params.name === REVIEW_TOOL_NAME) {
        return await this.handleReviewPlan(request.params.arguments as Record<string, unknown>, extra);
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
        // Auto-launch client if not running. Must precede publish: with no
        // timeout, publishing to a topic nobody reads blocks forever (A-10).
        this.requireClient();

        const repo = detectRepoContext();

        const mapOption = (opt: { label?: string; value?: string; description?: string; preview?: string }) => ({
          label: opt.label || opt.value || '',
          // Backfill value from label when the LLM omits it (agents habitually
          // call this tool like the built-in AskUserQuestion, which has no
          // `value` field). Symmetric with the label fallback above. Without
          // this, JSON.stringify drops the undefined `value` key and older
          // clients fail to deserialize the whole message, silently dropping
          // the popup.
          value: opt.value ?? opt.label ?? '',
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
          questions: batchQuestions,
        };

        console.error(`Publishing question ${questionMsg.messageId} to ntfy...`);
        await this.transport.publish(questionMsg);
        console.error('Question published. Waiting for answer...');

        this.transport.pending.record({
          kind: 'question',
          id: questionMsg.messageId,
          createdAt: Date.now(),
        });

        let answer;
        const stopHeartbeat = this.startHeartbeat(extra);
        try {
          answer = await this.transport.waitForAnswer(questionMsg.messageId, extra?.signal);
        } finally {
          // One finally for both: a host cancellation must release the SSE
          // connection and the timer together, or every stop/retry cycle leaks
          // one of each for the life of the process (D-9).
          stopHeartbeat();
          this.transport.pending.clear(questionMsg.messageId);
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

        throw new McpError(
          ErrorCode.InternalError,
          `Failed to get human response: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    });
  }

  /**
   * ReviewPlan: snapshot a markdown plan, publish it for line-anchored review,
   * and block until a human submits a verdict.
   */
  private async handleReviewPlan(
    args: Record<string, unknown>,
    extra: RequestExtra
  ): Promise<{ content: Array<{ type: string; text: string }> }> {
    if (typeof args?.filePath !== 'string' || args.filePath.trim() === '') {
      throw new McpError(ErrorCode.InvalidParams, 'Missing required parameter: filePath');
    }
    if (typeof args?.context !== 'string' || args.context.trim() === '') {
      throw new McpError(ErrorCode.InvalidParams, 'Missing required parameter: context');
    }

    // Validate and read before anything else: a rejected path must never reach
    // the snapshot store, ntfy, or the human's screen.
    let plan;
    try {
      plan = readPlanFile(args.filePath);
    } catch (err) {
      if (err instanceof PlanFileError) {
        throw new McpError(ErrorCode.InvalidParams, err.message);
      }
      throw err;
    }

    this.requireClient();

    const identity = resolvePlanIdentity(plan.resolvedPath);
    let recorded;
    try {
      recorded = prepareRevision(identity, plan.content);
    } catch (err) {
      // The store retries what is transient; anything reaching here is a real
      // filesystem problem, and a raw EPERM stack is not something an agent
      // can act on.
      throw new McpError(
        ErrorCode.InternalError,
        `Could not record a snapshot of ${identity.displayPath}: ${describeError(err)}. ` +
          `The plan review needs to write under ${path.dirname(identity.dir)}.`
      );
    }
    const snapshotHash = `sha256:${recorded.digest}`;
    const diff = buildPlanDiff(identity.displayPath, plan.content, resolveBaseline(identity, recorded));

    // Reuse the reviewId of an identical review this or a previous process was
    // still waiting on. A window may still be open for it on the human's
    // device, and its response then resolves this call instead of asking
    // again (D-8).
    const resumable = this.transport.pending.findResumableReview(identity.planId, snapshotHash);
    const reviewId = resumable?.id ?? uuidv4();

    const body: PlanReviewBody = { content: plan.content, diff };
    const encoded = encodePayload(body, this.config.encryptionKey);

    const reviewMsg: PlanReviewMessage = {
      type: 'plan_review',
      messageId: reviewId,
      timestamp: Date.now(),
      protocolVersion: PROTOCOL_VERSION,
      repo: detectRepoContext(path.dirname(plan.resolvedPath)),
      context: args.context,
      summary: typeof args.summary === 'string' ? args.summary : '',
      displayPath: identity.displayPath,
      planId: identity.planId,
      revision: recorded.revision,
      isNewPlan: recorded.isNewPlan,
      snapshotHash,
      body: encoded.ref,
    };

    this.transport.pending.record({
      kind: 'plan_review',
      id: reviewId,
      planId: identity.planId,
      snapshotHash,
      createdAt: Date.now(),
    });
    this.outstandingReviews.add(reviewId);

    console.error(
      `Publishing plan_review ${reviewId} (revision ${recorded.revision}, ` +
        `${encoded.ref.kind} payload, ${encoded.ref.contentLength} bytes) to ntfy...`
    );

    const stopHeartbeat = this.startHeartbeat(extra);

    // Watch for a second device submitting after the first one already won.
    // Registered before the wait so there is no window in which a late
    // response goes unnoticed; `watch` only sees what no waiter consumed, so
    // the winning response never reaches it (D-5).
    const stopWatchingLateResponses = this.transport.watch(
      `late_response:${reviewId}`,
      (msg) => msg.type === 'plan_review_response' && msg.reviewId === reviewId,
      (received) => {
        const late = received.msg as PlanReviewResponseMessage;
        console.error(`Review ${reviewId} already resolved; telling ${late.respondedFrom} it was lost.`);
        void this.publishAck(
          reviewId,
          late.messageId,
          'lost',
          'This review had already been submitted from another device.'
        );
      }
    );

    try {
      await this.transport.publishPlan(
        reviewMsg,
        encoded.ref.kind === 'attachment' ? encoded.cipher : undefined
      );

      // The revision is out the door, so it may now become the baseline the
      // next review diffs against (M6). A failure here only leaves the next
      // diff rebased on the older revision — worth saying out loud, not worth
      // abandoning a review the human is already looking at.
      try {
        recorded.commit();
      } catch (err) {
        console.error(
          `Published review ${reviewId} but could not update the snapshot pointer for ` +
            `${identity.displayPath}: ${describeError(err)}. The next review will diff against ` +
            `revision ${recorded.previous?.revision ?? 0}.`
        );
      }

      const { msg: response, attachment } = await this.transport.waitFor<PlanReviewResponseMessage>(
        `plan_review_response:${reviewId}`,
        (msg) => msg.type === 'plan_review_response' && msg.reviewId === reviewId,
        extra?.signal
      );

      const result = await this.consumeReviewResponse(reviewMsg, response, attachment);
      // Stay attached briefly so a submit that lost the race still gets told,
      // rather than the losing client sitting on a 30 s ack timeout.
      this.releaseLater(stopWatchingLateResponses);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      stopWatchingLateResponses();
      if (error instanceof McpError) throw error;
      console.error('ReviewPlan error:', error);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to get plan review: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    } finally {
      // Same finally for the timer and the wait registration: a host
      // cancellation must release both, not leak one per stop/retry cycle (D-9).
      stopHeartbeat();
      this.outstandingReviews.delete(reviewId);
      this.transport.pending.clear(reviewId);
    }
  }

  /**
   * Drop a subscription hold after the late-response window.
   *
   * The timer is unref'd so it can never be the reason the process stays alive.
   */
  private releaseLater(release: () => void): void {
    setTimeout(release, LATE_RESPONSE_WINDOW_MS).unref?.();
  }

  /**
   * Download, decode and validate a submitted review, then acknowledge it.
   *
   * The ack is what lets the client distinguish "the server read this" from "I
   * clicked submit": the response attachment expires after 3 h while the
   * message itself survives 12 h, so a submit can be accepted at click time and
   * still never arrive (C-12).
   */
  private async consumeReviewResponse(
    reviewMsg: PlanReviewMessage,
    response: PlanReviewResponseMessage,
    attachment?: AttachmentRef
  ): Promise<ReviewPlanResult> {
    let verdict: PlanVerdict;
    let body: PlanReviewResponseBody;
    try {
      // Inside the try so a client that sends nonsense is acknowledged as
      // lost rather than leaving the human's window claiming success.
      verdict = parseVerdict(response.verdict);

      // The human must have reviewed the content we published. A mismatch is a
      // stale window or a broken client, and accepting it would approve this
      // revision on the strength of a review of a different one (A-8/M5).
      if (response.snapshotHash && response.snapshotHash !== reviewMsg.snapshotHash) {
        throw new ReviewResponseError(
          `Response is for snapshot ${response.snapshotHash}, but this review published ` +
            `${reviewMsg.snapshotHash}.`
        );
      }

      const cipher =
        response.body?.kind === 'attachment'
          ? await this.downloadResponseBody(attachment)
          : response.body?.data ?? '';

      const decoded = decodePayload<unknown>(
        cipher,
        this.config.encryptionKey,
        response.body?.contentHash ?? ''
      );
      body = normalizeResponseBody(verdict, decoded, reviewMsg.displayPath);
    } catch (err) {
      await this.publishAck(reviewMsg.messageId, response.messageId, 'lost', describeError(err));
      if (err instanceof AttachmentExpiredError) {
        throw new McpError(
          ErrorCode.InternalError,
          `The review was submitted but its payload had already expired on ntfy (attachments live 3 h). ` +
            `Ask for the review again.`
        );
      }
      if (err instanceof PayloadDecodeError || err instanceof ReviewResponseError) {
        throw new McpError(ErrorCode.InternalError, `Unusable review response: ${err.message}`);
      }
      throw err;
    }

    await this.publishAck(reviewMsg.messageId, response.messageId, 'received');

    return {
      success: true,
      timestamp: response.timestamp,
      respondedFrom: response.respondedFrom,
      verdict,
      overallFeedback: body.overallFeedback,
      inlineComments: body.inlineComments,
      revision: reviewMsg.revision,
      isNewPlan: reviewMsg.isNewPlan,
      // Checked against what we published above, so this is the content the
      // human actually reviewed rather than whatever the client claimed (A-8).
      snapshotHash: reviewMsg.snapshotHash,
    };
  }

  private async downloadResponseBody(attachment?: AttachmentRef): Promise<string> {
    if (!attachment) {
      throw new McpError(
        ErrorCode.InternalError,
        'Review response claims an attachment payload but the message carried no attachment URL.'
      );
    }
    return await this.transport.downloadAttachment(attachment);
  }

  /** Tell the client whether its submission actually landed. */
  private async publishAck(
    reviewId: string,
    responseId: string,
    status: PlanReviewAckMessage['status'],
    reason?: string
  ): Promise<void> {
    const ack: PlanReviewAckMessage = {
      type: 'plan_review_ack',
      messageId: uuidv4(),
      timestamp: Date.now(),
      protocolVersion: PROTOCOL_VERSION,
      reviewId,
      responseId,
      status,
      reason,
    };
    try {
      await this.transport.publishPlan(ack);
    } catch (err) {
      console.error(`Could not acknowledge review ${reviewId}: ${err}`);
    }
  }

  /**
   * Fail before publishing when no client can be found or launched.
   *
   * Without a timeout to bound it, publishing to a topic nobody is subscribed
   * to is a permanent silent hang — the agent blocks and the human never sees a
   * window to explain why (A-10).
   */
  private requireClient(): void {
    const result = ensureClientRunning(SERVER_DIR);
    if (!result.ok) {
      throw new McpError(
        ErrorCode.InternalError,
        `No HITL client available, so nobody would see this. ${result.reason ?? ''}`.trim()
      );
    }
  }

  /**
   * Start emitting progress notifications, returning the stop function.
   *
   * Whether these actually keep the call alive is the calling host's decision:
   * the MCP SDK's DEFAULT_REQUEST_TIMEOUT_MSEC is 60 s and
   * `resetTimeoutOnProgress` defaults to false, so a host that does not opt in
   * will time the call out regardless of what we send (D-2).
   */
  private startHeartbeat(extra: RequestExtra): () => void {
    const progressToken = extra?._meta?.progressToken;
    if (progressToken === undefined) return () => {};

    let progressCount = 0;
    const timer = setInterval(async () => {
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

    return () => clearInterval(timer);
  }

  async run(): Promise<void> {
    const stdioTransport = new StdioServerTransport();
    await this.server.connect(stdioTransport);

    console.error(`${SERVER_NAME} v${SERVER_VERSION} running on stdio (ntfy-backed)`);

    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.error('Shutting down...');

      // Tell open review windows their agent is gone before dropping the
      // connection, so they show "agent exited" and keep the typed comments
      // rather than waiting on a process that no longer exists (D-3).
      // A hard kill (SIGKILL/OOM) cannot be caught here by design.
      await this.cancelOutstandingReviews('agent_exited');

      this.transport.close();
      process.exit(0);
    };

    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());
  }

  /** Publish cancel_review for every review still waiting on a human. */
  private async cancelOutstandingReviews(reason: CancelReviewMessage['reason']): Promise<void> {
    for (const reviewId of this.outstandingReviews) {
      const cancel: CancelReviewMessage = {
        type: 'cancel_review',
        messageId: uuidv4(),
        timestamp: Date.now(),
        protocolVersion: PROTOCOL_VERSION,
        reviewId,
        reason,
      };
      try {
        await this.transport.publishPlan(cancel);
      } catch (err) {
        console.error(`Could not cancel review ${reviewId}: ${err}`);
      }
    }
    this.outstandingReviews.clear();
  }
}

/**
 * True when this file is what node was asked to run, rather than something
 * another module imported.
 *
 * Compared through realpath because npm installs the `bin` entry as a symlink:
 * `process.argv[1]` is then the link in `node_modules/.bin`, not this file. If
 * the comparison cannot be made at all we boot — failing to start a server
 * someone asked for is far worse than starting one nobody wanted.
 */
function isDirectlyExecuted(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return true;
  }
}

if (isDirectlyExecuted()) {
  const server = new HumanInTheLoopServer();
  server.run().catch((error) => {
    console.error('Server error:', error);
    process.exit(1);
  });
}
