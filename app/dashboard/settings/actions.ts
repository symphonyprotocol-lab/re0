'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { disconnectGithub, disconnectNotion } from '@/lib/application/auth';
import { billingPortalUrl, CheckoutRefused, startCheckout } from '@/lib/application/billing';
import { requireSession } from '@/lib/http/session';
import { AppError } from '@/contracts/errors';
import { changeWorkspaceHandle, HandleRefused } from '@/lib/application/workspaces/handle';

/**
 * The settings page's mutations: forget a provider grant, and hand the buyer
 * to the Payment Provider.
 *
 * Connecting is not here -- it is the POST to `/api/auth/{provider}/connect`
 * that starts the consent, because it has to set the handshake cookie and
 * redirect to the provider. Disconnecting is a plain delete of the sealed
 * token under the current session's account; the provider-side grant stays
 * until the person revokes it there, which the page says.
 */
export async function disconnectGithubAction(): Promise<void> {
  const session = await requireSession('/dashboard/settings');
  await disconnectGithub(session.user.id);
  revalidatePath('/dashboard/settings');
  revalidatePath('/dashboard/assets/new');
}

export async function disconnectNotionAction(): Promise<void> {
  const session = await requireSession('/dashboard/settings');
  await disconnectNotion(session.user.id);
  revalidatePath('/dashboard/settings');
  revalidatePath('/dashboard/assets/new');
}

/**
 * Where a refused or failed billing action lands: back on the plan card, with
 * the reason in the query string for the page to print.
 */
function backToPlan(outcome: string): never {
  redirect(`/dashboard/settings?checkout=${outcome}#plan`);
}

/**
 * Sends the browser to the provider's checkout for one Additional Calls pack,
 * the only thing re0 sells (agent-first-proposal.md 8.1).
 *
 * The redirect sits outside the `try`: `redirect` works by throwing, and a
 * catch around it would swallow the navigation it exists to perform.
 */
export async function startCheckoutAction(): Promise<void> {
  const session = await requireSession('/dashboard/settings');
  let url: string;
  try {
    url = await startCheckout({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
    });
  } catch (error) {
    if (error instanceof CheckoutRefused) backToPlan(error.code);
    console.error('checkout failed', (error as Error).message);
    backToPlan('failed');
  }
  redirect(url);
}

/** Sends the browser to the provider's customer portal. */
export async function openBillingPortalAction(): Promise<void> {
  const session = await requireSession('/dashboard/settings');
  let url: string;
  try {
    url = await billingPortalUrl({ workspaceId: session.workspace.id, role: session.workspace.role });
  } catch (error) {
    if (error instanceof CheckoutRefused) backToPlan(error.code);
    console.error('billing portal failed', (error as Error).message);
    backToPlan('failed');
  }
  redirect(url);
}

/**
 * Changes the workspace's public handle (agent-first-proposal.md 12): the
 * `/u/{handle}` page and the user card's tenant. The outcome comes back on
 * `?handle=` for the page to word: `saved`, `invalid`, `reserved`, `taken`
 * or `denied`.
 */
export async function changeHandleAction(form: FormData): Promise<void> {
  const session = await requireSession('/dashboard/settings');
  let outcome = 'saved';
  try {
    await changeWorkspaceHandle({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      handle: String(form.get('handle') ?? ''),
    });
    revalidatePath('/dashboard/settings');
  } catch (error) {
    if (error instanceof HandleRefused) outcome = error.code;
    else if (error instanceof AppError && error.code === 'access_denied') outcome = 'denied';
    else {
      console.error(`change handle failed: ${error instanceof Error ? error.message : 'unknown'}`);
      outcome = 'unavailable';
    }
  }
  redirect(`/dashboard/settings?handle=${outcome}#handle`);
}
