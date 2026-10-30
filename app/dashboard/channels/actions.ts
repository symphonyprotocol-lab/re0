'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { AppError } from '@/contracts/errors';
import { createChannel, deleteChannel, editChannel, moveAsset, pinAsset } from '@/lib/application/channels';
import { ChannelRefused } from '@/lib/domain/channel';
import { requireSession } from '@/lib/http/session';

/**
 * The channels screen's actions (agent-first-proposal.md 6.1). Plain form
 * posts that land back on the page with the outcome in the query string --
 * a code the page words -- so they work without script. Each re-resolves
 * the session: a server action is a public endpoint with a generated name.
 *
 * P1's moves are these dashboard clicks; the agent's confirmation gate
 * (proposal 5.2) wraps the same use cases in P2.
 */

function refusalCode(error: unknown, verb: string): string {
  if (error instanceof ChannelRefused) return error.code;
  if (error instanceof AppError && error.code === 'access_denied') return 'access_denied';
  console.error(`${verb} failed: ${error instanceof Error ? error.message : 'unknown'}`);
  return 'unavailable';
}

function refresh(channelId?: string): void {
  revalidatePath('/dashboard/channels');
  revalidatePath('/dashboard/assets');
  if (channelId) revalidatePath(`/dashboard/channels/${channelId}`);
}

export async function createChannelAction(form: FormData): Promise<void> {
  const session = await requireSession('/dashboard/channels');
  let target: string;
  try {
    const { id } = await createChannel({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      slug: String(form.get('slug') ?? ''),
      title: String(form.get('title') ?? ''),
      description: String(form.get('description') ?? ''),
      visibility: String(form.get('visibility') ?? 'public'),
    });
    refresh();
    target = `/dashboard/channels/${id}?notice=created`;
  } catch (error) {
    target = `/dashboard/channels?error=${refusalCode(error, 'create channel')}`;
  }
  redirect(target);
}

export async function editChannelAction(form: FormData): Promise<void> {
  const channelId = String(form.get('channelId') ?? '');
  const session = await requireSession(`/dashboard/channels/${channelId}`);
  let outcome = 'saved';
  try {
    await editChannel({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      channelId,
      title: String(form.get('title') ?? ''),
      description: String(form.get('description') ?? ''),
      visibility: String(form.get('visibility') ?? 'public'),
    });
    refresh(channelId);
  } catch (error) {
    outcome = refusalCode(error, 'edit channel');
  }
  redirect(`/dashboard/channels/${channelId}?notice=${outcome}`);
}

export async function deleteChannelAction(form: FormData): Promise<void> {
  const channelId = String(form.get('channelId') ?? '');
  const session = await requireSession(`/dashboard/channels/${channelId}`);
  /* The confirmation is a typed checkbox, so a stray Enter cannot delete. */
  if (form.get('confirm') !== 'yes') redirect(`/dashboard/channels/${channelId}?notice=confirm_required#delete`);
  let target = '/dashboard/channels?notice=deleted';
  try {
    await deleteChannel({ workspaceId: session.workspace.id, role: session.workspace.role, channelId });
    refresh(channelId);
  } catch (error) {
    target = `/dashboard/channels/${channelId}?notice=${refusalCode(error, 'delete channel')}`;
  }
  redirect(target);
}

/** Moves an asset into this channel (from no channel or from another one). */
export async function addAssetAction(form: FormData): Promise<void> {
  const channelId = String(form.get('channelId') ?? '');
  const session = await requireSession(`/dashboard/channels/${channelId}`);
  let outcome = 'added';
  try {
    await moveAsset({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      assetId: String(form.get('assetId') ?? ''),
      channelId,
    });
    refresh(channelId);
  } catch (error) {
    outcome = refusalCode(error, 'add asset');
  }
  redirect(`/dashboard/channels/${channelId}?notice=${outcome}#assets`);
}

/** Takes an asset out of this channel: back to its owner alone, reset to free. */
export async function removeAssetAction(form: FormData): Promise<void> {
  const channelId = String(form.get('channelId') ?? '');
  const session = await requireSession(`/dashboard/channels/${channelId}`);
  let outcome = 'removed';
  try {
    await moveAsset({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      assetId: String(form.get('assetId') ?? ''),
      channelId: null,
    });
    refresh(channelId);
  } catch (error) {
    outcome = refusalCode(error, 'remove asset');
  }
  redirect(`/dashboard/channels/${channelId}?notice=${outcome}#assets`);
}

export async function pinAssetAction(form: FormData): Promise<void> {
  const channelId = String(form.get('channelId') ?? '');
  const session = await requireSession(`/dashboard/channels/${channelId}`);
  let outcome = form.get('pinned') === 'yes' ? 'pinned' : 'unpinned';
  try {
    await pinAsset({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      assetId: String(form.get('assetId') ?? ''),
      pinned: form.get('pinned') === 'yes',
    });
    refresh(channelId);
  } catch (error) {
    outcome = refusalCode(error, 'pin asset');
  }
  redirect(`/dashboard/channels/${channelId}?notice=${outcome}#assets`);
}
