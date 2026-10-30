import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ActionCard } from '@/components/dashboard/action-card';
import { BackLink, PageHeader } from '@/components/dashboard/ui';
import { actionById } from '@/lib/application/agent';
import { delegationsByActionIds } from '@/lib/application/external-agents';
import { requireSession } from '@/lib/http/session';
import { getMessages, translations } from '@/lib/i18n/server';
import { cardOf } from '@/lib/dashboard/action-card';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getMessages()).dashboard.agentActions.metaTitle };
}

/**
 * One pending action: the page an A2A task's `INPUT_REQUIRED` status links
 * to (agent-first-proposal.md 7.6). Another workspace's action is a 404,
 * like one that does not exist.
 */
export default async function PendingActionPage({ params }: { params: Promise<{ actionId: string }> }) {
  const { actionId } = await params;
  const [session, { t }] = await Promise.all([requireSession(`/dashboard/actions/${actionId}`), translations()]);
  const a = t.dashboard.agentActions;
  const action = await actionById(session.workspace.id, actionId);
  if (!action) notFound();
  const delegation = (await delegationsByActionIds(session.workspace.id, [action.id])).get(action.id) ?? null;
  return (
    <div className="flex flex-col gap-[18px]">
      <BackLink href="/dashboard/actions">{a.title}</BackLink>
      <PageHeader eyebrow={session.workspace.name} title={a.tools[action.tool]} description={a.description} />
      <div className="max-w-[560px]">
        <ActionCard action={cardOf(action, delegation)} origin={action.origin} taskId={action.a2aTaskId} />
      </div>
    </div>
  );
}
