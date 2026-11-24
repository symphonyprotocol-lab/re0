import type { Metadata } from 'next';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { currentUser } from '@/lib/http/session';
import { listCompetitions } from '@/lib/services/competitions';
import { UNLISTED_ROBOTS } from '@/lib/seo';
import { serverMessages } from '@/i18n/server';
import { FeedColumns } from '@/components/shell/feed-columns';
import { CompetitionCards } from '@/components/competitions/competition-cards';
import { Icon } from '@/components/ui/icons';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  /* The list is not indexed in the MVP (docs/design/competitions.md 13.2): each published competition is. */
  return { title: t.competitions.title, description: t.competitions.lede, robots: UNLISTED_ROBOTS };
}

/** `/competitions`: running competitions, nearest deadline first, or results (`?tab=published`), newest first. */
export default async function CompetitionsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const [user, { t, locale }, query] = await Promise.all([currentUser(), serverMessages(), searchParams]);
  const c = t.competitions;
  const tab = query.tab === 'published' ? 'published' : 'active';
  const page = await listCompetitions(tab, { cursor: query.cursor });
  const tabs = (
    <div className="cl-tabs" role="tablist" aria-label={c.title}>
      {(['active', 'published'] as const).map((key) => (
        <Link key={key} href={key === 'active' ? '/competitions' : '/competitions?tab=published'} role="tab" aria-selected={tab === key} className={`cl-tab${tab === key ? ' active' : ''}`} scroll={false}>
          {c.tabs[key]}
        </Link>
      ))}
    </div>
  );
  const rail = (
    <div className="discovery-page">
      <section className="rail-card">
        <h3>{c.title}</h3>
        <p className="text-[12px] leading-relaxed text-muted">{c.lede}</p>
        <div className="mt-3 flex flex-col gap-2">
          <Link href={user ? '/workspace/competitions/new' : '/login?returnTo=%2Fworkspace%2Fcompetitions%2Fnew'} className="btn btn-sm">
            <Icon name="plus" className="size-3.5" />
            {c.create}
          </Link>
          {user && (
            <Link href="/workspace/competitions" className="btn-secondary btn-sm">
              {c.mine}
            </Link>
          )}
        </div>
      </section>
    </div>
  );
  return (
    <FeedColumns title={c.title} tabs={tabs} rail={rail}>
      <div className="px-[18px] py-4">
        {page.items.length === 0 ? <p className="py-10 text-center text-[13px] text-muted">{c.empty[tab]}</p> : <CompetitionCards items={page.items} t={t} locale={locale} />}
        {page.next && (
          <p className="mt-4 text-center">
            <Link href={`/competitions?${new URLSearchParams({ ...(tab === 'published' ? { tab } : {}), cursor: page.next })}`} className="btn-secondary btn-sm">
              →
            </Link>
          </p>
        )}
      </div>
    </FeedColumns>
  );
}
