'use server';

import { redirect } from 'next/navigation';
import { startChannelCheckout } from '@/lib/application/channels/subscriptions';
import { askAuthor, askTwin } from '@/lib/application/questions';
import { normalizeChannelSlug } from '@/lib/domain/channel';
import { refusalCode } from '@/lib/http/refusal-code';
import { requireSession } from '@/lib/http/session';

/**
 * The channel page's actions (agent-first-proposal.md 6.3, 6.7, 6.9): open
 * a checkout for a plan, ask the AI twin, ask the author. Each needs a
 * signed-in reader; the twin's 1 Call is on the reader's workspace.
 */

function pageOf(form: FormData): string {
  const slug = normalizeChannelSlug(String(form.get('slug') ?? '')) ?? (form.get('slug') === 're0' ? 're0' : null);
  return slug ? `/channels/${slug}` : '/channels';
}

export async function subscribeAction(form: FormData): Promise<void> {
  const page = pageOf(form);
  const session = await requireSession(page);
  let target: string;
  try {
    target = await startChannelCheckout({
      userId: session.user.id,
      workspaceId: session.workspace.id,
      channelId: String(form.get('channelId') ?? ''),
      interval: String(form.get('interval') ?? ''),
    });
  } catch (error) {
    target = `${page}?subscribe=${refusalCode(error, 'channel checkout')}#subscribe`;
  }
  redirect(target);
}

export async function askTwinAction(form: FormData): Promise<void> {
  const page = pageOf(form);
  const session = await requireSession(page);
  let target: string;
  try {
    const reply = await askTwin({
      userId: session.user.id,
      workspaceId: session.workspace.id,
      channelId: String(form.get('channelId') ?? ''),
      question: String(form.get('question') ?? ''),
    });
    target = `${page}?twin=${reply.twinAnswerId}#twin`;
  } catch (error) {
    target = `${page}?twinError=${refusalCode(error, 'ask twin')}#twin`;
  }
  redirect(target);
}

export async function askAuthorAction(form: FormData): Promise<void> {
  const page = pageOf(form);
  const session = await requireSession(page);
  let outcome = 'done';
  try {
    await askAuthor({
      userId: session.user.id,
      channelId: String(form.get('channelId') ?? ''),
      question: String(form.get('question') ?? ''),
      nameConsent: form.get('nameConsent') === 'yes',
    });
  } catch (error) {
    outcome = refusalCode(error, 'ask author');
  }
  redirect(`${page}?asked=${outcome}#ask-author`);
}
