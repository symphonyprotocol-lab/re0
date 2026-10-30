'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { cancelChannelSubscription } from '@/lib/application/channels/subscriptions';
import { markNotificationsRead } from '@/lib/application/notifications';
import { refusalCode } from '@/lib/http/refusal-code';
import { requireSession } from '@/lib/http/session';

/** Cancelling keeps access to the end of the period (agent-first-proposal.md 6.9). */
export async function cancelSubscriptionAction(form: FormData): Promise<void> {
  const session = await requireSession('/dashboard/subscriptions');
  let notice = 'canceled';
  try {
    await cancelChannelSubscription({ userId: session.user.id, subscriptionId: String(form.get('subscriptionId') ?? '') });
    revalidatePath('/dashboard/subscriptions');
  } catch (error) {
    notice = refusalCode(error, 'cancel subscription');
  }
  redirect(`/dashboard/subscriptions?notice=${notice}`);
}

export async function markNotificationsReadAction(): Promise<void> {
  const session = await requireSession('/dashboard/notifications');
  await markNotificationsRead(session.user.id);
  revalidatePath('/dashboard', 'layout');
  redirect('/dashboard/notifications');
}
