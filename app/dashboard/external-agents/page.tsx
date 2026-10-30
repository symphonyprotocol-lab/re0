import type { Metadata } from 'next';
import { ExternalAgentCard, RegisterAgentForm } from '@/components/dashboard/external-agents';
import { PANEL, PageHeader } from '@/components/dashboard/ui';
import { listExternalAgents } from '@/lib/application/external-agents';
import { MAX_EXTERNAL_AGENTS } from '@/lib/domain/external-agent';
import { requireSession } from '@/lib/http/session';
import { fill } from '@/lib/i18n/format';
import { getMessages, translations } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getMessages()).dashboard.externalAgents.metaTitle };
}

/**
 * 外部 Agent (agent-first-proposal.md 7.9): the external A2A Agents this
 * workspace may delegate to, each with its card snapshot and at most one
 * credential, shown masked. Registering, re-fetching, disabling, removing
 * and every credential change are the owner's clicks here; the Agent can
 * only propose a delegation to one of them.
 */
export default async function ExternalAgentsPage() {
  const [session, { t }] = await Promise.all([requireSession('/dashboard/external-agents'), translations()]);
  const x = t.dashboard.externalAgents;
  const agents = await listExternalAgents(session.workspace.id);

  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader eyebrow={session.workspace.name} title={x.title} description={x.description} />
      <section className={`${PANEL} p-4`}>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-[13px] font-medium text-ink">{x.register}</h2>
          <span className="text-[11px] text-faint">
            {agents.length} / {fill(x.limit, { n: String(MAX_EXTERNAL_AGENTS) })}
          </span>
        </div>
        <RegisterAgentForm />
      </section>
      {agents.length === 0 ? (
        <p className="text-[12.5px] text-muted">{x.empty}</p>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {agents.map((agent) => (
            <ExternalAgentCard key={agent.id} agent={agent} />
          ))}
        </div>
      )}
    </div>
  );
}
