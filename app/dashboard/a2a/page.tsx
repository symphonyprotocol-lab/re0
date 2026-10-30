import type { Metadata } from 'next';
import Link from 'next/link';
import { DelegationPanel } from '@/components/dashboard/delegation-panel';
import { PANEL, PageHeader } from '@/components/dashboard/ui';
import { listWorkspaceTasks } from '@/lib/application/a2a/task-store';
import { listDelegations } from '@/lib/application/external-agents';
import { requireSession } from '@/lib/http/session';
import { getMessages, translations } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getMessages()).dashboard.a2aTasks.metaTitle };
}

/**
 * A2A 任务 (agent-first-proposal.md 4.4, 7.6): the tasks other agents started
 * with this workspace's keys -- ids, skills, states, never message bodies --
 * and a link to the confirmation of any that waits for the owner. Below
 * them, the outbound side (proposal 7.9): the delegations re0 sent to
 * external Agents after the owner confirmed, with what came back, framed as
 * the external Agent's output.
 */
export default async function A2aTasksPage() {
  const [session, { locale, t }] = await Promise.all([requireSession('/dashboard/a2a'), translations()]);
  const a = t.dashboard.a2aTasks;
  const [tasks, delegations] = await Promise.all([listWorkspaceTasks(session.workspace.id), listDelegations(session.workspace.id)]);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader eyebrow={session.workspace.name} title={a.title} description={a.description} />
      <h2 className="text-[13px] font-medium text-ink">{a.inboundTitle}</h2>
      {tasks.length === 0 ? (
        <p className="text-[12.5px] text-muted">{a.empty}</p>
      ) : (
        <div className={`${PANEL} overflow-x-auto`}>
          <table className="w-full text-left text-[12px]">
            <thead className="border-b border-line text-[11px] text-muted">
              <tr>
                <th className="px-4 py-2.5 font-medium">{a.columns.task}</th>
                <th className="px-4 py-2.5 font-medium">{a.columns.skill}</th>
                <th className="px-4 py-2.5 font-medium">{a.columns.state}</th>
                <th className="px-4 py-2.5 font-medium">{a.columns.card}</th>
                <th className="px-4 py-2.5 font-medium">{a.columns.updated}</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => (
                <tr key={task.id} className="border-b border-line/60 last:border-0">
                  <td className="px-4 py-2.5 font-mono text-[11px] text-ink">{task.id}</td>
                  <td className="px-4 py-2.5 text-ink">{task.skill ?? '—'}</td>
                  <td className="px-4 py-2.5 text-muted">
                    {a.states[task.state as keyof typeof a.states] ?? task.state}
                    {task.pendingActionId ? (
                      <>
                        {' · '}
                        <Link href={`/dashboard/actions/${task.pendingActionId}`} className="text-brandink hover:underline">
                          {a.confirmLink}
                        </Link>
                      </>
                    ) : null}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-[11px] text-muted">{task.tenant || a.platform}</td>
                  <td className="px-4 py-2.5 text-muted">{date.format(new Date(task.updatedAt))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <section className="flex flex-col gap-2">
        <h2 className="text-[13px] font-medium text-ink">{a.outboundTitle}</h2>
        <p className="text-[12px] text-muted">{a.outboundDescription}</p>
        {delegations.length === 0 ? (
          <p className="text-[12.5px] text-muted">{a.outboundEmpty}</p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {delegations.map((delegation) => (
              <div key={delegation.id} className={`${PANEL} p-3`}>
                <p className="text-[12px] text-ink">
                  {delegation.agentName}
                  <span className="ml-2 text-[11px] text-faint">{date.format(new Date(delegation.createdAt))}</span>
                </p>
                <DelegationPanel delegation={delegation} />
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
