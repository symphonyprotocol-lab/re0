import type { Metadata } from 'next';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { notFound } from 'next/navigation';
import { currentUser } from '@/lib/http/session';
import { knowledgeQuery } from '@/lib/http/knowledge';
import { db } from '@/lib/infra/db';
import { knowledgeHeader, matchingIds } from '@/lib/services/knowledge';
import { ownedRee } from '@/lib/services/rees';
import { serverMessages } from '@/i18n/server';
import { fill } from '@/i18n/format';
import { ReeTopbar } from '@/components/rees/ree-topbar';
import { Icon } from '@/components/ui/icons';
import { KnowledgePreviewPage } from '@/components/knowledge/knowledge-preview-page';
import { SOURCE_ICONS } from '@/components/knowledge/kind-icons';
import '@/components/knowledge/knowledge.css';

type Props = { params: Promise<{ id: string; kid: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.knowledge.page.title };
}

/**
 * `/rees/[id]/knowledge/[kid]`: one source on its own page. The library's
 * filters ride along in the query, so previous / next walk the same list
 * the owner came from; `?t=` starts audio at a citation's second.
 */
export default async function KnowledgeSourcePage({ params, searchParams }: Props) {
  const { id, kid } = await params;
  const raw = await searchParams;
  const user = (await currentUser())!;
  const ree = await ownedRee(db(), user.id, id);
  if (!ree) notFound();
  const { t } = await serverMessages();
  const k = t.knowledge;
  const header = await knowledgeHeader(ree.id, kid);

  const filters = new URLSearchParams();
  for (const name of ['q', 'kind', 'folder', 'status', 'sort', 'size', 'page', 'view']) {
    const value = raw[name];
    if (typeof value === 'string' && value) filters.set(name, value);
  }
  const listHref = `/rees/${ree.id}/knowledge${filters.size ? `?${filters}` : ''}`;
  const sourceHref = (other: string) => `/rees/${ree.id}/knowledge/${other}${filters.size ? `?${filters}` : ''}`;
  /* 工作台 › 我的 Ree › Ree › 知识管理 › the source (prototype app.js). */
  const crumbs = [{ label: t.reeSetup.tabs.knowledge, href: listHref }, { label: header?.title || k.page.title }];

  if (!header) {
    return (
      <>
        <ReeTopbar ree={ree} active="knowledge" crumbs={crumbs} />
        <main className="knowledge-ui">
          <div className="page">
            <div className="card empty">
              <Icon name="file" />
              <h2>{k.page.missingTitle}</h2>
              <p>{k.page.missingBody}</p>
              <Link href={listHref} className="btn secondary">
                {k.page.back}
              </Link>
            </div>
          </div>
        </main>
      </>
    );
  }

  const ids = await matchingIds(ree.id, knowledgeQuery(filters));
  const index = ids.indexOf(kid);
  const previous = index > 0 ? sourceHref(ids[index - 1]!) : null;
  const next = index >= 0 && index < ids.length - 1 ? sourceHref(ids[index + 1]!) : null;
  const time = Number(typeof raw.t === 'string' ? raw.t : NaN);
  const child = Number(typeof raw.child === 'string' ? raw.child : 0);

  return (
    <>
      <ReeTopbar
        ree={ree}
        active="knowledge"
        crumbs={crumbs}
        actions={
          <div className="flex items-center gap-1">
            <span className="hidden font-mono text-[11px] text-muted sm:inline">{index < 0 ? '—' : index + 1} / {ids.length}</span>
            {previous ? (
              <Link href={previous} className="icon-btn" aria-label={k.page.previous}>
                <Icon name="chevronLeft" />
              </Link>
            ) : (
              <span className="icon-btn opacity-40" aria-hidden="true">
                <Icon name="chevronLeft" />
              </span>
            )}
            {next ? (
              <Link href={next} className="icon-btn" aria-label={k.page.next}>
                <Icon name="chevronRight" />
              </Link>
            ) : (
              <span className="icon-btn opacity-40" aria-hidden="true">
                <Icon name="chevronRight" />
              </span>
            )}
          </div>
        }
      />
      <main className="knowledge-ui">
        <div className="kp-page">
          <div className="kp-page-head">
            <span className="file-icon">
              <Icon name={SOURCE_ICONS[header.kind]} />
            </span>
            <div>
              <h1 title={header.title}>{header.title}</h1>
              <p>{fill(k.page.subtitle, { ree: ree.name })}</p>
            </div>
          </div>
          <div className="card kp-page-card">
            <KnowledgePreviewPage
              reeId={ree.id}
              knowledgeId={kid}
              initialTime={Number.isFinite(time) && time >= 0 ? time : null}
              initialChild={Number.isInteger(child) && child >= 0 ? child : 0}
              previousHref={previous}
              nextHref={next}
            />
          </div>
        </div>
      </main>
    </>
  );
}
