/** Discoverable tool schemas; server-side validation remains authoritative. */
const strings = { type: 'array', items: { type: 'string', maxLength: 4000 }, maxItems: 100 };
export const WORK_TOOLS = [
  {
    name: 'UpdateWork',
    description: 'Use for multi-step work, milestones, and team progress: keep one living document in the user\'s Inbox with outcomes, learnings, current work, next steps, and blockers. Prefer this to repeated one-off Notify calls for the same goal. Create one root, then let each agent report its own task under the same workId and parent link. Each call replaces one complete task report; the server retains other tasks and publishes the full document. ReadWork first when resuming or resolving a revision conflict; retain your task\'s still-relevant fields. Use the task revision as expectedRevision, not the document revision. Use a new updateId for a new update; retry identical input after an uncertain response or publication failure. Check saved and published separately before claiming delivery. Routine updates are quiet; alert only for meaningful milestones, blockers, decisions, or completion. Storage is durable on this coordinating host, scoped to the configured topic; agents must share that store.',
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: 'object' as const,
      required: ['workId', 'updateId', 'expectedRevision', 'task'],
      properties: {
        workId: { type: 'string', maxLength: 200, description: 'Stable ID shared by every task for this goal, e.g. sign-in-reliability. Reuse it to update the same Inbox document.' },
        updateId: { type: 'string', maxLength: 200, description: 'Unique logical update ID, e.g. lead-tests-passed. Reuse with identical input for retries; never reuse for changed content.' },
        expectedRevision: { type: 'integer', minimum: 0, description: 'Current revision of this task from ReadWork; 0 creates a task. On conflict, read, reconcile, and submit a new updateId. Document revision counts all task updates and is not this value.' },
        title: { type: 'string', maxLength: 300, description: 'Required when creating the root document. Only root task updates may change it.' },
        goal: { type: 'string', maxLength: 4000, description: 'Desired outcome; required for root creation. Only root task updates may change it.' },
        summary: { type: 'string', maxLength: 4000, description: 'Optional prose context. The complete document stays authoritative.' },
        changes: { ...strings, description: 'What changed in this update, supplied by you. This is not an automatic diff or changes since the user last read.' },
        alert: { type: 'boolean', default: false, description: 'False quietly refreshes the document without opening a popup. True requests attention for a meaningful milestone, blocker, decision, or completion; avoid trivial alerts.' },
        task: {
          type: 'object',
          description: 'Complete replacement of this one task report, not a delta. Include every required field. Arrays replace previous arrays; [] clears a list and current:null clears current work. Other tasks are retained.',
          required: ['taskId', 'parentTaskId', 'owner', 'reportedBy', 'status', 'completed', 'learnings', 'current', 'remaining', 'blockers'],
          properties: {
            taskId: { type: 'string', maxLength: 200, description: 'Stable ID for the task you are reporting, e.g. lead or api-tests.' },
            parentTaskId: { type: ['string', 'null'], maxLength: 200, description: 'Null creates the one root; child tasks link to an existing task ID in this document.' },
            owner: { type: 'string', maxLength: 200, description: 'Agent or person responsible for this task.' },
            reportedBy: { type: 'string', maxLength: 200, description: 'Agent writing this report; may differ from the owner when a lead records a child report.' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'blocked', 'completed', 'cancelled'], description: 'Explicit task lifecycle. Set root completion explicitly when the goal is done; notification dismissal does not complete work.' },
            completed: { ...strings, description: 'Complete retained list of completed outcomes; replaces the previous list.' },
            learnings: { ...strings, description: 'Complete retained list of findings and their implications; replaces the previous list.' },
            remaining: { ...strings, description: 'Complete list of work still ahead; replaces the previous list.' },
            blockers: { ...strings, description: 'Current blockers or needed decisions; [] clears resolved blockers.' },
            current: { anyOf: [{ type: 'null' }, { type: 'object', required: ['action', 'purpose'], properties: { action: { type: 'string', maxLength: 4000 }, purpose: { type: 'string', maxLength: 4000 } } }] },
          },
        },
      },
    },
  },
  {
    name: 'ReadWork', description: 'Use before resuming tracked work, summarizing team progress, or recovering from an UpdateWork revision conflict. Returns the full saved goal and task tree so you can collect recorded child reports, retain your own complete task fields, and get its revision for the next UpdateWork. Each task revision is used as expectedRevision; the document revision tracks all task updates. Reports show only what agents last wrote: this tool does not query agents or refresh their status automatically. Request fresh child reports through your agent host, then record them with UpdateWork. Reads the coordinating host\'s topic-scoped store without publishing a notification.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object' as const, properties: { workId: { type: 'string', maxLength: 200, description: 'The stable workId used by UpdateWork for this goal, e.g. sign-in-reliability.' } }, required: ['workId'] },
  },
];

