'use server';

import { after } from 'next/server';
import { revalidatePath } from 'next/cache';
import { confirmAction, rejectAction } from '@/lib/application/agent';
import { syncBuildTasks } from '@/lib/application/a2a/task-events';
import { delegationsByActionIds, type DelegationView } from '@/lib/application/external-agents';
import { canManageLibraries } from '@/lib/application/libraries';
import { runOperation } from '@/lib/application/ingestion';
import { ActionRefused, type ActionState, type ConfirmActor } from '@/lib/domain/agent-action';
import { requireSession } from '@/lib/http/session';

/**
 * The confirmation card's two buttons (agent-first-proposal.md 5.2). These
 * server actions are the only place an `owner` actor is built: from the
 * session of the person who clicked, re-resolved on every call because a
 * server action is a public endpoint. Neither the model nor an A2A caller
 * reaches here -- they hold no session -- and nothing a card posts but the
 * action id and the digest it was shown is read.
 */

export interface DecideResult {
  ok: boolean;
  state: ActionState | null;
  /** A refusal code the card words (`dashboard.agentActions.errors`). */
  error: string | null;
  reason: string | null;
  /** A confirmed delegation: the remote task it started (proposal 7.9). */
  delegation?: DelegationView | null;
}

async function ownerActor(): Promise<Extract<ConfirmActor, { kind: 'owner' }>> {
  const session = await requireSession('/dashboard/actions');
  return {
    kind: 'owner',
    userId: session.user.id,
    workspaceId: session.workspace.id,
    canManage: canManageLibraries(session.workspace.role),
  };
}

function refresh(): void {
  revalidatePath('/dashboard');
  revalidatePath('/dashboard/actions');
  revalidatePath('/dashboard/assets');
  revalidatePath('/dashboard/channels');
  revalidatePath('/dashboard/a2a');
  revalidatePath('/dashboard/external-agents');
}

function refused(error: unknown): DecideResult {
  if (error instanceof ActionRefused) {
    const code = ['not_found', 'not_owner', 'not_pending', 'expired', 'stale'].includes(error.code) ? error.code : 'unavailable';
    return { ok: false, state: error.code === 'expired' ? 'expired' : null, error: code, reason: null };
  }
  console.error(`agent action decision failed: ${error instanceof Error ? error.message : 'unknown'}`);
  return { ok: false, state: null, error: 'unavailable', reason: null };
}

export async function confirmPendingAction(_previous: DecideResult | null, form: FormData): Promise<DecideResult> {
  const actor = await ownerActor();
  try {
    const { action, operationId } = await confirmAction(actor, {
      actionId: String(form.get('actionId') ?? ''),
      digest: String(form.get('digest') ?? ''),
    });
    refresh();
    /* The build the confirmation queued starts now; the drain retries it if this run is lost. */
    if (operationId) {
      after(async () => {
        try {
          await runOperation({ operationId });
          await syncBuildTasks();
        } catch (error) {
          console.error(`confirmed build run failed: ${error instanceof Error ? error.message : 'unknown'}`);
        }
      });
    }
    const delegation =
      action.tool === 'delegate_task' ? ((await delegationsByActionIds(actor.workspaceId, [action.id])).get(action.id) ?? null) : null;
    return { ok: action.state === 'confirmed', state: action.state, error: null, reason: action.error, delegation };
  } catch (error) {
    return refused(error);
  }
}

export async function rejectPendingAction(_previous: DecideResult | null, form: FormData): Promise<DecideResult> {
  const actor = await ownerActor();
  try {
    const action = await rejectAction(actor, { actionId: String(form.get('actionId') ?? '') });
    refresh();
    return { ok: true, state: action.state, error: null, reason: null };
  } catch (error) {
    return refused(error);
  }
}
