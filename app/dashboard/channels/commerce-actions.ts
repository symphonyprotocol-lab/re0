'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  enableSubscriptions,
  retireChannelPlan,
  setAssetAccess,
  setChannelPlan,
  setSubscriberDailyLimit,
} from '@/lib/application/channels/subscriptions';
import { refusalCode } from '@/lib/http/refusal-code';
import { requireSession } from '@/lib/http/session';

/**
 * Selling a channel (agent-first-proposal.md 6.9-6.11): switching
 * subscriptions on with the rights confirmation, setting or retiring a
 * plan's price, the per-subscriber daily cap, and an asset's free/paid
 * flag. People's clicks only: setting a price is not an Agent tool (5.1).
 */

async function run(form: FormData, notice: string, act: (session: Awaited<ReturnType<typeof requireSession>>, channelId: string) => Promise<void>) {
  const channelId = String(form.get('channelId') ?? '');
  const session = await requireSession(`/dashboard/channels/${channelId}`);
  let outcome = notice;
  try {
    await act(session, channelId);
    revalidatePath(`/dashboard/channels/${channelId}`);
  } catch (error) {
    outcome = refusalCode(error, 'channel commerce');
  }
  redirect(`/dashboard/channels/${channelId}?commerce=${outcome}#commerce`);
}

export async function enableSubscriptionsAction(form: FormData): Promise<void> {
  await run(form, 'enabled', (session, channelId) =>
    enableSubscriptions({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      userId: session.user.id,
      channelId,
      confirmRights: form.get('confirmRights') === 'yes',
    }),
  );
}

export async function setChannelPlanAction(form: FormData): Promise<void> {
  const retire = form.get('intent') === 'retire';
  await run(form, retire ? 'retired' : 'plan', async (session, channelId) => {
    const base = { workspaceId: session.workspace.id, role: session.workspace.role, channelId, interval: String(form.get('interval') ?? '') };
    if (retire) await retireChannelPlan(base);
    else await setChannelPlan({ ...base, userId: session.user.id, price: String(form.get('price') ?? '') });
  });
}

export async function setDailyLimitAction(form: FormData): Promise<void> {
  await run(form, 'limit', (session, channelId) => {
    const raw = String(form.get('limit') ?? '').trim();
    return setSubscriberDailyLimit({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      channelId,
      limit: raw === '' ? null : Number(raw),
    });
  });
}

export async function setAssetAccessAction(form: FormData): Promise<void> {
  await run(form, 'access', (session) =>
    setAssetAccess({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      assetId: String(form.get('assetId') ?? ''),
      access: String(form.get('access') ?? ''),
    }),
  );
}
