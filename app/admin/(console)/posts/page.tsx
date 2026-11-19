import type { Metadata } from 'next';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { requireAdministrator } from '@/lib/http/admin';
import { adminPosts } from '@/lib/services/posts';
import { serverMessages } from '@/i18n/server';
import { ConsolePage, ConsoleTopbar } from '@/components/admin/console-topbar';
import { PageHead } from '@/components/admin/list-kit';
import { AdminPostsTable } from '@/components/admin/admin-posts';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.posts.admin.title };
}

const VIEWS = ['reported', 'hidden', 'all'] as const;

/** `/admin/posts`: public posts to take down or restore (v5, review round 2 B2), reported first; `?view=` and `?q=`. */
export default async function AdminPostsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requireAdministrator();
  const [{ t }, params] = await Promise.all([serverMessages(), searchParams]);
  const a = t.posts.admin;
  const view = VIEWS.includes(params.view as (typeof VIEWS)[number]) ? (params.view as (typeof VIEWS)[number]) : 'reported';
  const q = params.q?.slice(0, 200) ?? '';
  const rows = await adminPosts({ view, q });
  return (
    <ConsolePage>
      <ConsoleTopbar crumbs={[{ label: t.console.nav.home, href: '/admin/overview' }, { label: a.title }]} />
      <div className="console-body">
        <PageHead title={a.title} lede={a.lede} />
        <section className="card">
          <div className="flex flex-wrap items-center gap-3 p-4">
            <nav className="flex gap-2" aria-label={a.title}>
              {VIEWS.map((key) => (
                <Link key={key} href={`/admin/posts?view=${key}${q ? `&q=${encodeURIComponent(q)}` : ''}`} className={`btn sm ${view === key ? '' : 'ghost'}`} aria-current={view === key ? 'page' : undefined}>
                  {a.views[key]}
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
