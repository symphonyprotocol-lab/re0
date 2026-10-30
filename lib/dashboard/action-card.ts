import type { PendingActionView } from '@/lib/application/agent';
import type { DelegationView } from '@/lib/application/external-agents/delegation';
import type { WorkbenchAction } from '@/lib/http/playground-stream';

/** A pending action as its confirmation card takes it (components/dashboard/action-card.tsx). */
export function cardOf(action: PendingActionView, delegation: DelegationView | null = null): WorkbenchAction {
  return {
    id: action.id,
    tool: action.tool,
    state: action.state,
    summary: action.summary,
    digest: action.digest,
    expiresAt: action.expiresAt,
    error: action.error,
    delegation,
  };
}
