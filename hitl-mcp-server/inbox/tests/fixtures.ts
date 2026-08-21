// Recordings of what `list_sessions()` and `list_messages()` return.
//
// Deliberately data, never logic. Session state, ordering, filtering and the
// Unattributed grouping are all decided in Rust and tested there
// (`inbox/src-tauri/src/{session,view,identity}.rs`); reimplementing any of it
// here would mean these tests could pass while the app was wrong.
//
// The field names are pinned from the other side by
// `view::tests::the_json_the_panes_receive_is_camel_case_and_complete`, so a
// serde rename fails a Rust test rather than silently blanking a pane.

/** A fixed clock, matching the one the Rust tests use. */
export const NOW = 1_786_600_000;
export const MINUTE = 60;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export interface Badges {
  repo: string | null;
  batchCount: number | null;
  revision: number | null;
  attachment: boolean;
  plaintext: boolean | null;
}

export interface MessageRow {
  messageId: string;
  msgType: string;
  glyph: string;
  title: string;
  status: string;
  verdict: string | null;
  createdAt: number;
  ageSeconds: number;
  responder: string | null;
  respondedAt: number | null;
  contextSnippet: string | null;
  badges: Badges;
  /** Set only on a spilled body; what pane 3 fetches with. Never rendered here. */
  contentHash: string | null;
  sessionKey: string | null;
  sessionLabel: string | null;
  projectKey: string;
  unattributed: boolean;
}

export interface SessionRow {
  sessionKey: string;
  label: string;
  projectKey: string;
  scopeKey: string;
  state: string;
  glyph: string;
  pendingCount: number;
  messageCount: number;
  lastEventAt: number;
}

export interface ProjectNode {
  projectKey: string;
  name: string;
  scopeKey: string;
  state: string;
  glyph: string;
  pendingCount: number;
  messageCount: number;
  lastEventAt: number;
  sessions: SessionRow[];
  unattributed: boolean;
}

export interface SessionTree {
  projects: ProjectNode[];
  totalPending: number;
  totalMessages: number;
  scopeKey: string;
  now: number;
}

export interface MessageList {
  messages: MessageRow[];
  counts: { all: number; needsYou: number; answered: number; notifications: number };
  filter: string;
  defaultFilter: string;
  scopeKey: string;
  now: number;
}

const GLYPHS: Record<string, string> = {
  waiting: '●',
  active: '◐',
  idle: '○',
  stale: '○',
};

export function session(over: Partial<SessionRow> & { sessionKey: string }): SessionRow {
  const state = over.state ?? 'idle';
  return {
    label: over.sessionKey,
    projectKey: 'Hitl_MCP',
    scopeKey: `session:${over.sessionKey}`,
    glyph: GLYPHS[state],
    pendingCount: 0,
    messageCount: 1,
    lastEventAt: NOW - HOUR,
    ...over,
    state,
  };
}

export function project(over: Partial<ProjectNode> & { projectKey: string }): ProjectNode {
  const state = over.state ?? 'idle';
  return {
    name: over.projectKey,
    scopeKey: `project:${over.projectKey}`,
    glyph: GLYPHS[state],
    pendingCount: 0,
    messageCount: 1,
    lastEventAt: NOW - HOUR,
    sessions: [],
    unattributed: false,
    ...over,
    state,
  };
}

export function unattributedNode(over: Partial<ProjectNode> = {}): ProjectNode {
  return project({
    projectKey: '__unattributed__',
    name: 'Unattributed',
    scopeKey: 'unattributed',
    unattributed: true,
    sessions: [],
    ...over,
  });
}

export function tree(over: Partial<SessionTree> = {}): SessionTree {
  const projects = over.projects ?? [];
  return {
    totalPending: projects.reduce((n, p) => n + p.pendingCount, 0),
    totalMessages: projects.reduce((n, p) => n + p.messageCount, 0),
    scopeKey: 'all',
    now: NOW,
    ...over,
    projects,
  };
}

export function message(over: Partial<MessageRow> & { messageId: string }): MessageRow {
  const msgType = over.msgType ?? 'question';
  const createdAt = over.createdAt ?? NOW - 2 * MINUTE;
  return {
    msgType,
    glyph: { question: '?', notification: '!', plan_review: '▤' }[msgType] ?? '·',
    title: 'Proceed?',
    status: 'pending',
    verdict: null,
    createdAt,
    ageSeconds: Math.max(0, NOW - createdAt),
    responder: null,
    respondedAt: null,
    contextSnippet: null,
    contentHash: null,
    sessionKey: 'Hitl_MCP · master · a3f2',
    sessionLabel: 'master · a3f2',
    projectKey: 'Hitl_MCP',
    unattributed: false,
    ...over,
    badges: {
      repo: null,
      batchCount: null,
      revision: null,
      attachment: false,
      plaintext: null,
      ...(over.badges ?? {}),
    },
  };
}

export function list(over: Partial<MessageList> = {}): MessageList {
  const messages = over.messages ?? [];
  const open = (m: MessageRow) => m.status === 'pending' || m.status === 'stale';
  const counts = over.counts ?? {
    all: messages.length,
    needsYou: messages.filter(open).length,
    answered: messages.filter(m => !open(m)).length,
    notifications: messages.filter(m => m.msgType === 'notification').length,
  };
  const defaultFilter = over.defaultFilter ?? (counts.needsYou > 0 ? 'needs_you' : 'all');
  return {
    filter: defaultFilter,
    scopeKey: 'all',
    now: NOW,
    ...over,
    messages,
    counts,
    defaultFilter,
  };
}

/** What the harness reads off `window.__INBOX_FIXTURE`. */
export interface Fixture {
  sessions?: SessionTree;
  messages?: MessageList | Record<string, MessageList>;
}
