/** Discoverable tool schemas; server-side validation remains authoritative. */
const strings = { type: 'array', items: { type: 'string', maxLength: 4000 }, maxItems: 100 };
export const WORK_TOOLS = [
  {
    name: 'UpdateWork',
    description: 'Save one agent task and publish the full living work document. Use a stable updateId for retries. expectedRevision is the task revision (0 creates it); ReadWork provides current revisions. Root creation needs title, goal and a null parentTaskId. Only root task updates may change title or goal. Send the complete task report; omitted task fields are invalid. Updates are quiet by default; use alert for milestones or decisions. Storage is durable on this coordinating host and scoped to the configured topic. saved and published are separate; retry identical input after publication failure.',
    inputSchema: {
      type: 'object' as const,
      required: ['workId', 'updateId', 'expectedRevision', 'task'],
      properties: {
        workId: { type: 'string', maxLength: 200 }, updateId: { type: 'string', maxLength: 200 },
        expectedRevision: { type: 'integer', minimum: 0 }, title: { type: 'string', maxLength: 300 }, goal: { type: 'string', maxLength: 4000 },
        summary: { type: 'string', maxLength: 4000, description: 'Optional prose context. The complete document stays authoritative.' },
        changes: strings, alert: { type: 'boolean', default: false },
        task: {
          type: 'object',
          required: ['taskId', 'parentTaskId', 'owner', 'reportedBy', 'status', 'completed', 'learnings', 'current', 'remaining', 'blockers'],
          properties: {
            taskId: { type: 'string', maxLength: 200 }, parentTaskId: { type: ['string', 'null'], maxLength: 200 },
            owner: { type: 'string', maxLength: 200 }, reportedBy: { type: 'string', maxLength: 200 },
            status: { type: 'string', enum: ['pending', 'in_progress', 'blocked', 'completed', 'cancelled'] },
            completed: strings, learnings: strings, remaining: strings, blockers: strings,
            current: { anyOf: [{ type: 'null' }, { type: 'object', required: ['action', 'purpose'], properties: { action: { type: 'string', maxLength: 4000 }, purpose: { type: 'string', maxLength: 4000 } } }] },
          },
        },
      },
    },
  },
  {
    name: 'ReadWork', description: 'Read the current full saved work document from this coordinating host. Reports reflect what agents last wrote; this does not contact agents for fresh status. Use your agent host to request fresh child reports. Document revision tracks all updates; each task has its own expectedRevision.',
    inputSchema: { type: 'object' as const, properties: { workId: { type: 'string', maxLength: 200 } }, required: ['workId'] },
  },
];

