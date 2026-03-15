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
  question: string;
  header?: string;
  options: DialogOption[];
  allowMultiple?: boolean;
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
}

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

/** Union type for all messages over the ntfy channel. */
export type HitlMessage = QuestionMessage | AnswerMessage;

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
}

export interface HitlToolError {
  success: false;
  error: string;
  message: string;
}
