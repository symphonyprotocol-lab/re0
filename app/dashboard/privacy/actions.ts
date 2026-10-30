'use server';

import { revalidatePath } from 'next/cache';
import { AppError } from '@/contracts/errors';
import { deleteA2aTasks, deleteConversations, isRetentionChoice, setPrivateAssetRetention } from '@/lib/application/privacy';
import { requireSession } from '@/lib/http/session';

/**
 * 导出与删除 (agent-first-proposal.md 10): one-click deletion of
 * conversations and A2A task records, and the private-asset retention
 * setting. Each re-resolves the session; only an owner or admin may.
 */
export interface PrivacyResult {
  ok: boolean;
  count: number | null;
  error: 'access_denied' | 'invalid' | 'unavailable' | null;
}

function refused(error: unknown): PrivacyResult {
  if (error instanceof AppError && error.code === 'access_denied') return { ok: false, count: null, error: 'access_denied' };
  if (error instanceof AppError && error.code === 'invalid_request') return { ok: false, count: null, error: 'invalid' };
  console.error(`privacy action failed: ${error instanceof Error ? error.message : 'unknown'}`);
  return { ok: false, count: null, error: 'unavailable' };
}

export async function deleteRecordsAction(_previous: PrivacyResult | null, form: FormData): Promise<PrivacyResult> {
  const session = await requireSession('/dashboard/privacy');
  const input = { workspaceId: session.workspace.id, role: session.workspace.role };
  try {
    const what = String(form.get('what') ?? '');
    const count =
      what === 'conversations' ? await deleteConversations(input) : what === 'tasks' ? await deleteA2aTasks(input) : null;
    if (count === null) return { ok: false, count: null, error: 'invalid' };
    revalidatePath('/dashboard');
    revalidatePath('/dashboard/a2a');
    revalidatePath('/dashboard/privacy');
    return { ok: true, count, error: null };
  } catch (error) {
    return refused(error);
  }
}

export async function setRetentionAction(_previous: PrivacyResult | null, form: FormData): Promise<PrivacyResult> {
  const session = await requireSession('/dashboard/privacy');
  const raw = String(form.get('days') ?? '');
  const days = raw === '' || raw === 'keep' ? null : Number(raw);
  if (!isRetentionChoice(days)) return { ok: false, count: null, error: 'invalid' };
  try {
    await setPrivateAssetRetention({ workspaceId: session.workspace.id, role: session.workspace.role, days });
    revalidatePath('/dashboard/privacy');
    return { ok: true, count: null, error: null };
  } catch (error) {
    return refused(error);
  }
}
