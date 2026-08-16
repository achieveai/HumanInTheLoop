// ============================================================
// @hitl/shared — Protocol types for HITL MCP cross-machine messaging
// ============================================================

/** A selectable option presented to the human. */
export interface DialogOption {
  /** Display label for the option */
  label: string;
  /** Machine-readable value returned on selection */
  value: string;
  /** Optional longer description shown below the label */
  description?: string;
  /** Optional markdown content shown in a side panel when this option is focused */
  preview?: string;
}

/** A single question within a batch ask_question call. */
export interface SubQuestion {
  /** The question text (supports markdown) */
  question: string;
  /** Short chip label shown above the question (~12 chars max) */
  header?: string;
  /** Selectable options */
  options: DialogOption[];
  /** Whether multiple options can be selected (default: false) */
  allowMultiple?: boolean;
  /** Whether a free-text "additional context" field is shown (default: true) */
  allowOther?: boolean;
}

/** Answer to a single sub-question within a batch response. */
export interface SubAnswer {
  questionIndex: number;
  questionText: string;
  selectedValues: string[];
  otherText?: string;
  skipped?: boolean;
  responseType: 'selection' | 'selection_with_context' | 'context_only' | 'skipped' | 'none';
  selectedPreview?: string;
}

/** Git repository context auto-detected by the MCP server. */
export interface RepoContext {
  /** Repository root directory name */
  name: string;
  /** Current branch */
  branch: string;
  /** Remote origin URL (if available) */
  remoteUrl?: string;
}

/** Which resolution tier produced a `SenderIdentity` label. */
export type SenderIdentitySource = 'session' | 'worktree' | 'path';

/** Resolved, display-ready sender identity for a machine/session sending a message. */
export interface SenderIdentity {
  /** Display label, e.g. "Kay9 - work-item/1-reviewplan". Never an absolute path (F-9). */
  label: string;
  source: SenderIdentitySource;
}

// -----------------------------------------------------------
// ntfy.sh message envelope
// -----------------------------------------------------------

/** Base fields present on every message over the ntfy channel. */
interface BaseMessage {
  /** Discriminated union tag */
  type: string;
  /** Unique ID for this message */
  messageId: string;
  /** Unix-epoch millis when the message was created */
  timestamp: number;
  /**
   * Wire-shape version. Absent ⇒ 1.
   *
   * Emitted ONLY on plan_review / plan_review_response / plan_review_ack /
   * cancel_review. The four shipping types (question, answer, notification,
   * dismiss_notification) must keep a byte-identical wire format so a new
   * server never breaks an already-installed client.
   *
   * Increment only when the wire shape changes — NEVER derive it from the
   * package version.
   */
  protocolVersion?: number;
}

/** Current wire-shape version. See BaseMessage.protocolVersion. */
export const PROTOCOL_VERSION = 2;

/** Published by MCP server when the LLM calls ask_human. */
export interface QuestionMessage extends BaseMessage {
  type: 'question';
  /** Auto-detected git repo context */
  repo: RepoContext | null;
  /** LLM-provided description of what project/work is being done */
  context: string;
  /** The question to ask the human (ignored when questions array is present) */
  question: string;
  /** Selectable options (ignored when questions array is present) */
  options: DialogOption[];
  /** Whether multiple options can be selected */
  allowMultiple: boolean;
  /** Whether a free-text "additional context" field is shown */
  allowOther: boolean;
  /** Timeout in milliseconds (0 = no timeout) */
  timeout?: number;
  /** Batch questions — when present, question/options at top level are ignored */
  questions?: SubQuestion[];
}

/** Published by a client app when the human responds. */
export interface AnswerMessage extends BaseMessage {
  type: 'answer';
  /** The messageId of the original QuestionMessage */
  questionId: string;
  /** Hostname / device name of the machine that answered */
  respondedFrom: string;
  /** Selected option value(s) */
  selectedValues: string[];
  /** Free-text provided by the user */
  otherText?: string;
  /** Whether the user explicitly skipped */
  skipped: boolean;
  /** Per-question answers for batch questions */
  subAnswers?: SubAnswer[];
}

/**
 * Union of the four message types that predate `protocolVersion`.
 * Their wire format is frozen — see BaseMessage.protocolVersion.
 */
export type HitlMessage = QuestionMessage | AnswerMessage | NotificationMessage | DismissNotificationMessage;

/** Published by MCP server for fire-and-forget progress notifications. */
export interface NotificationMessage extends BaseMessage {
  type: 'notification';
  /** Short title for the notification */
  title: string;
  /** Notification body text (supports markdown) */
  body: string;
  /** Optional context about what triggered this notification */
  context?: string;
}

/** Published by a client when user dismisses a notification. */
export interface DismissNotificationMessage extends BaseMessage {
  type: 'dismiss_notification';
  /** The messageId of the notification being dismissed */
  notificationId: string;
  /** Device that dismissed it */
  dismissedFrom: string;
}

/**
 * Decorates a question or notification with the sender's resolved identity.
 *
 * Deliberately NOT part of the `HitlMessage` union and does not extend
 * `BaseMessage` — this carries no identity of its own, only a pointer back to
 * the message it decorates. Published once, right after that message, by a
 * sibling of `publishPlan`. Delivery order versus the message it decorates is
 * not guaranteed; a client that cannot match `forMessageId` to an open or
 * soon-to-open window drops it silently — sender identity is decoration only,
 * never required.
 */
export interface SenderIdentityMessage {
  type: 'sender_identity';
  /** messageId of the question/notification this decorates. */
  forMessageId: string;
  forType: 'question' | 'notification';
  sender: SenderIdentity;
}

// -----------------------------------------------------------
// Transport-level chunking (for messages exceeding ntfy's size limit)
// -----------------------------------------------------------

/**
 * A fragment of an oversized message body, published as its own ntfy message.
 * Not part of the `HitlMessage` union — it's a transport wrapper that never
 * survives past reassembly on the receiving side.
 */
export interface ChunkMessage extends BaseMessage {
  type: 'chunk';
  /** messageId of the original (pre-chunking) message this fragment belongs to */
  groupId: string;
  /** 0-based position of this fragment */
  index: number;
  /** Total number of fragments in the group */
  total: number;
  /** Slice of the base64-encoded original body */
  data: string;
}

// -----------------------------------------------------------
// Plan review (protocolVersion 2)
//
// These four types are the ONLY ones that carry `protocolVersion`, gzip their
// body, and may spill to an ntfy attachment. They never chunk. The four types
// above keep their exact pre-existing wire format.
// -----------------------------------------------------------

export type PlanVerdict = 'approved' | 'changes_requested' | 'rejected' | 'skipped' | 'cancelled';

/**
 * ntfy-event-level attachment metadata, parsed off the raw ntfy JSON event.
 * NEVER carried inside our own message — the URL only exists after the PUT.
 * This is plaintext metadata outside our encryption, which is why `name` must
 * be random hex and never a real path (F-9).
 */
export interface AttachmentRef {
  name: string;
  url: string;
  type?: string;
  size?: number;
  /** Unix seconds. ntfy expires attachments after 3 h — messages after 12 h. */
  expires?: number;
}

/** Where a plan-review body lives, and how to verify it once fetched. */
export interface PlanPayloadRef {
  kind: 'inline' | 'attachment';
  /** inline only: the encrypted-envelope JSON string produced by crypto.encrypt() */
  data?: string;
  /** sha256 hex of the payload plaintext (the base64(gzip(bodyJson)) string) */
  contentHash: string;
  /** utf-8 byte length of that same payload plaintext */
  contentLength: number;
}

/** The gzipped body of a plan_review message. */
export interface PlanReviewBody {
  content: string;
  diff: string;
}

/** Published by the MCP server when the agent calls ReviewPlan. */
export interface PlanReviewMessage extends BaseMessage {
  type: 'plan_review';
  protocolVersion: number;
  repo: RepoContext | null;
  context: string;
  /** '' when absent — never undefined */
  summary: string;
  /** repo-relative ONLY, never an absolute path (F-9) */
  displayPath: string;
  /** identity hash of the plan file location; keys drafts across revisions */
  planId: string;
  revision: number;
  isNewPlan: boolean;
  /** 'sha256:<hex>' of the plan file content */
  snapshotHash: string;
  body: PlanPayloadRef;
}

/** A single line-anchored comment, in source-line space. */
export interface InlineComment {
  path: string;
  startLine: number;
  endLine: number;
  side: 'old' | 'new';
  comment: string;
}

/** The gzipped body of a plan_review_response message. */
export interface PlanReviewResponseBody {
  overallFeedback: string;
  inlineComments: InlineComment[];
}

/** Published by a client when the human finishes reviewing. */
export interface PlanReviewResponseMessage extends BaseMessage {
  type: 'plan_review_response';
  protocolVersion: number;
  /** messageId of the plan_review being answered */
  reviewId: string;
  respondedFrom: string;
  verdict: PlanVerdict;
  snapshotHash: string;
  body: PlanPayloadRef;
}

/**
 * Published by the server once it has actually read a response body. Without
 * it the client shows "submitted" at click time even when the response
 * attachment later 404s (attachments expire in 3 h, messages in 12 h).
 */
export interface PlanReviewAckMessage extends BaseMessage {
  type: 'plan_review_ack';
  protocolVersion: number;
  reviewId: string;
  responseId: string;
  status: 'received' | 'lost';
  reason?: string;
}

/** Published by the server when an outstanding review will never be read. */
export interface CancelReviewMessage extends BaseMessage {
  type: 'cancel_review';
  protocolVersion: number;
  reviewId: string;
  reason: 'agent_exited' | 'cancelled' | 'superseded';
}

/** Union of the plan-review message types. These never chunk. */
export type PlanMessage =
  | PlanReviewMessage
  | PlanReviewResponseMessage
  | PlanReviewAckMessage
  | CancelReviewMessage;

/** Anything that can arrive on the topic (excluding the transport-only chunk wrapper). */
export type AnyHitlMessage = HitlMessage | PlanMessage;

// -----------------------------------------------------------
// Configuration (~/.hitl/config.json)
// -----------------------------------------------------------

export interface HitlConfig {
  /** ntfy topic ID — a UUID used as the shared channel */
  topicId: string;
  /** ntfy server URL (default: https://ntfy.sh) */
  ntfyUrl: string;
  /** Human-readable name for this device */
  deviceName: string;
  /** Whether to play notification sounds */
  soundEnabled: boolean;
  /** Optional AES-256-GCM encryption key (64-char hex string) for encrypting messages */
  encryptionKey?: string;
  /** Whether this device publishes its own sender identity (default: true) */
  identityEnabled?: boolean;
}

export const DEFAULT_NTFY_URL = 'https://ntfy.sh';

export const DEFAULT_CONFIG: Omit<HitlConfig, 'topicId'> = {
  ntfyUrl: DEFAULT_NTFY_URL,
  deviceName: '',
  soundEnabled: true,
};

// -----------------------------------------------------------
// MCP tool response (returned to LLM)
// -----------------------------------------------------------

export interface HitlToolResponse {
  success: boolean;
  timestamp: number;
  selectedValues?: string | string[];
  context?: string;
  skipped?: boolean;
  response?: string;
  responseType: 'selection' | 'selection_with_context' | 'context_only' | 'skipped' | 'none';
  respondedFrom?: string;
  /** Populated for batch questions (questions array) */
  answers?: SubAnswer[];
}

export interface HitlToolError {
  success: false;
  error: string;
  message: string;
}
