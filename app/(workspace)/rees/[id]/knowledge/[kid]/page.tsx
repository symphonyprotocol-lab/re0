import type { Metadata } from 'next';
import Link from 'next/link';
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
import { KIND_ICONS } from '@/components/knowledge/kind-icons';

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
        <main className="mx-auto max-w-[760px] px-4 py-16 md:px-8">
          <div className="card flex flex-col items-center gap-3 px-6 py-14 text-center">
            <Icon name="file" className="size-6 text-blue" />
            <h1 className="text-[17px] font-bold">{k.page.missingTitle}</h1>
            <p className="text-[12px] text-muted">{k.page.missingBody}</p>
            <Link href={listHref} className="btn-secondary btn-sm">
              {k.page.back}
            </Link>
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
      <main className="mx-auto max-w-[1280px] px-4 py-8 md:px-8">
        <div className="flex min-w-0 items-center gap-3">
          <span className="inline-flex size-11 flex-none items-center justify-center rounded-xl bg-soft text-blue">
            <Icon name={KIND_ICONS[header.kind]} className="size-5" />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-[22px] font-extrabold tracking-tight" title={header.title}>
              {header.title}
            </h1>
            <p className="truncate text-[12px] text-muted">{fill(k.page.subtitle, { ree: ree.name })}</p>
          </div>
        </div>
        <div className="card mt-5 p-4 sm:p-6">
          <KnowledgePreviewPage
            reeId={ree.id}
            knowledgeId={kid}
            initialTime={Number.isFinite(time) && time >= 0 ? time : null}
            initialChild={Number.isInteger(child) && child >= 0 ? child : 0}
            previousHref={previous}
            nextHref={next}
          />
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-[12px] text-muted">
          <span>{index >= 0 && fill(k.page.position, { n: index + 1, total: ids.length })}</span>
          <div className="flex gap-2">
            {previous && (
              <Link href={previous} className="btn-secondary btn-sm">
                <Icon name="chevronLeft" className="size-3.5" />
                {k.page.previous}
              </Link>
            )}
            {next && (
              <Link href={next} className="btn-secondary btn-sm">
                {k.page.next}
                <Icon name="chevronRight" className="size-3.5" />
              </Link>
            )}
            <Link href={listHref} className="btn-secondary btn-sm">
              {k.page.back}
            </Link>
          </div>
        </div>
      </main>
    </>
  );
}
