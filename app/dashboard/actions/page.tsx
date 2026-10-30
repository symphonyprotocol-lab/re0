import type { Metadata } from 'next';
import { ActionCard } from '@/components/dashboard/action-card';
import { PageHeader } from '@/components/dashboard/ui';
import { listActions } from '@/lib/application/agent';
import { cardOf } from '@/lib/dashboard/action-card';
import { requireSession } from '@/lib/http/session';
import { getMessages, translations } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getMessages()).dashboard.agentActions.metaTitle };
}

/**
 * 待确认的操作 (agent-first-proposal.md 4.4, 5.2, 7.6): every pending action
 * of the workspace, from the workbench and from A2A callers alike, with the
 * owner's two buttons; and the ones decided lately, with their outcome.
 */
export default async function PendingActionsPage() {
  const [session, { t }] = await Promise.all([requireSession('/dashboard/actions'), translations()]);
  const a = t.dashboard.agentActions;
  const actions = await listActions(session.workspace.id, { limit: 60 });
  const pending = actions.filter((action) => action.state === 'pending');
  const decided = actions.filter((action) => action.state !== 'pending').slice(0, 20);

  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader eyebrow={session.workspace.name} title={a.title} description={a.description} />
      {pending.length === 0 ? <p className="text-[12.5px] text-muted">{a.empty}</p> : null}
      <div className="grid gap-3 md:grid-cols-2">
        {pending.map((action) => (
          <ActionCard key={action.id} action={cardOf(action)} origin={action.origin} taskId={action.a2aTaskId} />
        ))}
      </div>
      {decided.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-[13px] font-medium text-ink">{a.history}</h2>
          <div className="grid gap-3 md:grid-cols-2">
            {decided.map((action) => (
              <ActionCard key={action.id} action={cardOf(action)} origin={action.origin} taskId={action.a2aTaskId} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
