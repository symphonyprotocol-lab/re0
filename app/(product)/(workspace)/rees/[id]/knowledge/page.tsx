import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { currentUser } from '@/lib/http/session';
import { db } from '@/lib/infra/db';
import { ownedRee } from '@/lib/services/rees';
import { serverMessages } from '@/i18n/server';
import { ReeTopbar } from '@/components/rees/ree-topbar';
import { KnowledgeManager } from '@/components/knowledge/knowledge-manager';
import { WorkspaceSourcesCard, type ReeCardData } from '@/components/files/workspace-ui';
import { reeWorkspaceCard } from '@/lib/services/workspace-rees';
import { clientLabel } from '@/lib/domain/workspace';
import { formatDateTime } from '@/i18n/format';
import '@/components/knowledge/knowledge.css';
import '@/components/files/files.css';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.knowledge.title };
}

export default async function KnowledgePage({ params }: { params: Promise<{ id: string }> }) {
  const user = (await currentUser())!;
  const ree = await ownedRee(db(), user.id, (await params).id);
  if (!ree) notFound();
  const { locale } = await serverMessages();
  const card = await reeWorkspaceCard(user.id, ree.id);
  const data: ReeCardData = {
    reeId: ree.id,
    slug: ree.slug,
    published: card.published,
    texts: card.texts,
    bindings: card.bindings,
    waiting: card.waiting.map((row) => ({ id: row.id, title: row.title, path: row.path, secretFound: row.secretFound, client: clientLabel(row.updatedClient), updatedLabel: formatDateTime(row.updatedAt, locale), chunks: row.chunks })),
  };
  return (
    <>
      <ReeTopbar ree={ree} active="knowledge" />
      {/* Workspace sources (docs/design/agent-workspace.md §2.3): the bound folders and the files waiting for confirmation. */}
      <div className="knowledge-ui files-ui ws-ree-card">
        <WorkspaceSourcesCard data={data} />
      </div>
      <KnowledgeManager reeId={ree.id} />
    </>
  );
}
