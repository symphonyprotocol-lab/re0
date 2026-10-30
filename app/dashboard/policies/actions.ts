'use server';

import { revalidatePath } from 'next/cache';
import { AppError } from '@/contracts/errors';
import {
  applyWorkspacePolicy,
  previewWorkspacePolicy,
} from '@/lib/application/policies';
import type { WorkspacePolicy } from '@/lib/domain/policy';
import { requireSession } from '@/lib/http/session';

/**
 * The access-rules page's two actions. requirement.md 5.2 访问规则.
 *
 * Each re-resolves the session: a server action is a public endpoint with a
 * generated name, and the page rendering a button says nothing about who can
 * post to it. The role is re-checked in the use case, not here, so the API
 * and the console cannot disagree about who may change the rules.
 */
export interface ReachableCountResult {
  ok: boolean;
  reachable?: number;
}

/** The number of assets a draft would admit, before it is applied. */
export async function countReachableAssets(draft: WorkspacePolicy): Promise<ReachableCountResult> {
  const session = await requireSession('/dashboard/policies');
  try {
    return { ok: true, reachable: await previewWorkspacePolicy({ workspaceId: session.workspace.id, draft }) };
  } catch (error) {
    console.error(`policy preview failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return { ok: false };
  }
}

export interface ApplyPolicyResult {
  ok: boolean;
  versionId?: string | null;
  policy?: WorkspacePolicy;
  reachable?: number;
  error?: 'access_denied' | 'invalid' | 'unavailable';
}

/** Pin a new immutable version holding the draft; new requests use it from then on. */
export async function applyPolicyAction(
  base: WorkspacePolicy,
  draft: WorkspacePolicy,
): Promise<ApplyPolicyResult> {
  const session = await requireSession('/dashboard/policies');
  try {
    const state = await applyWorkspacePolicy({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      base,
      draft,
    });
    revalidatePath('/dashboard/policies');
    return {
      ok: true,
      versionId: state.versionId,
      policy: state.policy,
      reachable: state.reachable,
    };
  } catch (error) {
    if (error instanceof AppError && error.code === 'access_denied') {
      return { ok: false, error: 'access_denied' };
    }
    if (error instanceof AppError && error.code === 'invalid_request') {
      return { ok: false, error: 'invalid' };
    }
    console.error(`apply policy failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return { ok: false, error: 'unavailable' };
  }
}
