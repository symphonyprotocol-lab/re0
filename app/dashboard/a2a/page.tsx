import type { Metadata } from 'next';
import Link from 'next/link';
import { PANEL, PageHeader } from '@/components/dashboard/ui';
import { listWorkspaceTasks } from '@/lib/application/a2a/task-store';
import { requireSession } from '@/lib/http/session';
import { getMessages, translations } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getMessages()).dashboard.a2aTasks.metaTitle };
}

/**
 * A2A 任务 (agent-first-proposal.md 4.4, 7.6): the tasks other agents started
 * with this workspace's keys -- ids, skills, states, never message bodies --
 * and a link to the confirmation of any that waits for the owner.
 */
export default async function A2aTasksPage() {
  const [session, { locale, t }] = await Promise.all([requireSession('/dashboard/a2a'), translations()]);
  const a = t.dashboard.a2aTasks;
  const tasks = await listWorkspaceTasks(session.workspace.id);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader eyebrow={session.workspace.name} title={a.title} description={a.description} />
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
    </div>
  );
}
