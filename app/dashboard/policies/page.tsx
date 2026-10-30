import type { Metadata } from 'next';
import { PolicyEditor } from '@/components/dashboard/policy-editor';
import { Notice, PageHeader } from '@/components/dashboard/ui';
import { EyeIcon, ShieldCheckIcon } from '@/components/ui/icons';
import { canManagePolicy, readWorkspacePolicy } from '@/lib/application/policies';
import { requireSession } from '@/lib/http/session';
import { getMessages } from '@/lib/i18n/server';
import { fill } from '@/lib/i18n/format';
import { applyPolicyAction, countReachableAssets } from './actions';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getMessages()).dashboard.policies.metaTitle };
}

/**
 * Access rules. requirement.md 5.2: workspace-scoped, applied to every new
 * Web, REST and MCP request; Owner/Admin edit, Developer and Viewer read.
 */
export default async function DashboardPoliciesPage() {
  const [session, messages] = await Promise.all([
    requireSession('/dashboard/policies'),
    getMessages(),
  ]);
  const p = messages.dashboard.policies;
  const canEdit = canManagePolicy(session.workspace.role);
  const state = await readWorkspacePolicy(session.workspace.id);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow={p.eyebrow}
        title={p.title}
        description={p.description}
        action={
          <span className="inline-flex h-8 items-center gap-1.5 rounded-full bg-brandsoft px-3 text-[11px] text-brandink">
            <ShieldCheckIcon size={14} />
            {p.guardBadge}
          </span>
        }
      />
      {canEdit ? null : (
        <Notice
          icon={<EyeIcon size={18} />}
          title={p.editor.readOnlyTitle}
          body={fill(p.editor.readOnlyBody, { role: p.editor.roles[session.workspace.role] })}
        />
      )}
      <PolicyEditor
        initial={state.policy}
        versionId={state.versionId}
        reachable={state.reachable}
        canEdit={canEdit}
        countAction={countReachableAssets}
        applyAction={canEdit ? applyPolicyAction : undefined}
      />
    </div>
  );
}
