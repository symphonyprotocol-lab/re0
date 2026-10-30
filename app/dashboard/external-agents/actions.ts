'use server';

import { revalidatePath } from 'next/cache';
import { AppError } from '@/contracts/errors';
import {
  cancelDelegation,
  deleteAgentCredential,
  pollDelegation,
  refreshExternalAgent,
  registerExternalAgent,
  removeExternalAgent,
  saveAgentCredential,
  setExternalAgentStatus,
  type DelegationView,
} from '@/lib/application/external-agents';
import { ActionRefused } from '@/lib/domain/agent-action';
import { ExternalAgentRefused, type CredentialKind } from '@/lib/domain/external-agent';
import { requireSession } from '@/lib/http/session';

/**
 * The external Agent registry's buttons and the delegation card's two
 * (agent-first-proposal.md 7.9). Each re-resolves the session: a server
 * action is a public endpoint. Nothing here returns a credential -- a save
 * answers with `ok` and the page re-renders the masked view -- and nothing
 * logs one: a refusal is reduced to its code before it leaves.
 */
export interface RegistryResult {
  ok: boolean;
  /** A code the page words (`dashboard.externalAgents.errors`). */
  error: string | null;
}

function refused(error: unknown): RegistryResult {
  if (error instanceof ExternalAgentRefused) return { ok: false, error: error.code };
  if (error instanceof AppError && error.code === 'access_denied') return { ok: false, error: 'access_denied' };
  console.error(`external agent action failed: ${error instanceof Error ? error.name : 'unknown'}`);
  return { ok: false, error: 'unavailable' };
}

function refresh(): void {
  revalidatePath('/dashboard/external-agents');
}

export async function registerAgentAction(_previous: RegistryResult | null, form: FormData): Promise<RegistryResult> {
  const session = await requireSession('/dashboard/external-agents');
  try {
    await registerExternalAgent({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      userId: session.user.id,
      cardUrl: String(form.get('cardUrl') ?? ''),
    });
    refresh();
    return { ok: true, error: null };
  } catch (error) {
    return refused(error);
  }
}

/** Re-fetch, disable, enable or remove, by the `op` the button posts. */
export async function manageAgentAction(_previous: RegistryResult | null, form: FormData): Promise<RegistryResult> {
  const session = await requireSession('/dashboard/external-agents');
  const input = { workspaceId: session.workspace.id, role: session.workspace.role, agentId: String(form.get('agentId') ?? '') };
  try {
    switch (String(form.get('op') ?? '')) {
      case 'refetch':
        await refreshExternalAgent(input);
        break;
      case 'disable':
        await setExternalAgentStatus({ ...input, status: 'disabled' });
        break;
      case 'enable':
        await setExternalAgentStatus({ ...input, status: 'active' });
        break;
      case 'remove':
        await removeExternalAgent(input);
        break;
      case 'delete-credential':
        await deleteAgentCredential(input);
        break;
      default:
        return { ok: false, error: 'unavailable' };
    }
    refresh();
    return { ok: true, error: null };
  } catch (error) {
    return refused(error);
  }
}

export async function saveCredentialAction(_previous: RegistryResult | null, form: FormData): Promise<RegistryResult> {
  const session = await requireSession('/dashboard/external-agents');
  try {
    await saveAgentCredential({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      userId: session.user.id,
      agentId: String(form.get('agentId') ?? ''),
      kind: String(form.get('kind') ?? '') as CredentialKind,
      secret: String(form.get('secret') ?? ''),
    });
    refresh();
    return { ok: true, error: null };
  } catch (error) {
    return refused(error);
  }
}

export interface DelegationResult {
  ok: boolean;
  delegation: DelegationView | null;
  error: string | null;
}

/** The delegation card's GetTask (`op=poll`) and CancelTask (`op=cancel`). */
export async function followDelegationAction(_previous: DelegationResult | null, form: FormData): Promise<DelegationResult> {
  const session = await requireSession('/dashboard');
  const input = { workspaceId: session.workspace.id, role: session.workspace.role, delegationId: String(form.get('delegationId') ?? '') };
  try {
    const delegation = String(form.get('op') ?? '') === 'cancel' ? await cancelDelegation(input) : await pollDelegation(input);
    revalidatePath('/dashboard/a2a');
    return { ok: true, delegation, error: null };
  } catch (error) {
    if (error instanceof ActionRefused) return { ok: false, delegation: null, error: 'unavailable' };
    const { error: code } = refused(error);
    return { ok: false, delegation: null, error: code };
  }
}
