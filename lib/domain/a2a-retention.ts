/**
 * Proposal 10: the bodies of A2A tasks are kept 30 days, ids, states and
 * metering for good. One rule for both directions -- tasks other Agents send
 * re0 (`a2a/task-store.ts`) and tasks re0 delegates to external Agents
 * (`external-agents/delegation.ts`) -- so it is one constant both read.
 */
export const A2A_BODY_RETENTION_DAYS = 30;
