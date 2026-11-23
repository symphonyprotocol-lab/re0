import type { Metadata } from 'next';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { requireAdministrator } from '@/lib/http/admin';
import { ADMIN_POST_VIEWS as VIEWS, adminPostCounts, adminPosts, quoteReviewCount, type AdminPostView } from '@/lib/services/posts';
import { serverMessages } from '@/i18n/server';
import { formatNumber } from '@/i18n/format';
import { ConsolePage, ConsoleTopbar } from '@/components/admin/console-topbar';
import { PageHead } from '@/components/admin/list-kit';
import { AdminPostsTable } from '@/components/admin/admin-posts';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.posts.admin.title };
}

/**
 * `/admin/posts`: public posts to take down or restore (v5, review round 2
 * B2); `?view=` and `?q=`. Without a view it opens on Reported while
 * anything is reported, else on All, so an empty Reported tab never reads as
 * "no posts".
 */
export default async function AdminPostsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requireAdministrator();
  const [{ t, locale }, params] = await Promise.all([serverMessages(), searchParams]);
  const a = t.posts.admin;
  const q = params.q?.slice(0, 200) ?? '';
  const [counts, waiting] = await Promise.all([adminPostCounts(q), quoteReviewCount()]);
  const view: AdminPostView = VIEWS.includes(params.view as AdminPostView) ? (params.view as AdminPostView) : counts.reported > 0 ? 'reported' : 'all';
  const rows = await adminPosts({ view, q });
  return (
    <ConsolePage>
      <ConsoleTopbar crumbs={[{ label: t.console.nav.home, href: '/admin/overview' }, { label: a.title }]} />
      <div className="console-body">
        <PageHead title={a.title} lede={a.lede} />
        {/* Posts quoting a taken-down post: their answers stay public until reviewed (default, see the PR), so the count stands out. */}
        {waiting > 0 && (
          <div className="info-strip mb16">
            <Link href="/admin/posts?view=quotes">{a.quoteReviewBanner.replace('{n}', String(waiting))}</Link>
          </div>
        )}
        <section className="card">
          <div className="flex flex-wrap items-center gap-3 p-4">
            <nav className="flex gap-2" aria-label={a.title}>
              {VIEWS.map((key) => (
                <Link key={key} href={`/admin/posts?view=${key}${q ? `&q=${encodeURIComponent(q)}` : ''}`} className={`btn sm ${view === key ? '' : 'ghost'}`} aria-current={view === key ? 'page' : undefined}>
                  {a.views[key]} <span className="mono">{formatNumber(counts[key], locale)}</span>
                </Link>
              ))}
            </nav>
            <form action="/admin/posts" className="ml-auto flex gap-2">
              <input type="hidden" name="view" value={view} />
              <input name="q" defaultValue={q} placeholder={a.search} aria-label={a.search} className="input sm" />
            </form>
          </div>
          <AdminPostsTable rows={rows} />
        </section>
      </div>
    </ConsolePage>
  );
}
