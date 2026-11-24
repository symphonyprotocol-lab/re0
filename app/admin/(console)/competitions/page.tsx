import type { Metadata } from 'next';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { requireAdministrator } from '@/lib/http/admin';
import { ADMIN_COMPETITION_VIEWS as VIEWS, adminCompetitions, type AdminCompetitionView } from '@/lib/services/competitions';
import { serverMessages } from '@/i18n/server';
import { ConsolePage, ConsoleTopbar } from '@/components/admin/console-topbar';
import { PageHead } from '@/components/admin/list-kit';
import { AdminCompetitionsTable } from '@/components/admin/admin-competitions';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.competitions.admin.title };
}

/** `/admin/competitions` (docs/design/competitions.md 13.2): running, reported, big score changes, or all; `?view=` and `?q=`. */
export default async function AdminCompetitionsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requireAdministrator();
  const [{ t }, params] = await Promise.all([serverMessages(), searchParams]);
  const a = t.competitions.admin;
  const q = params.q?.slice(0, 80) ?? '';
  const view: AdminCompetitionView = VIEWS.includes(params.view as AdminCompetitionView) ? (params.view as AdminCompetitionView) : 'active';
  const rows = await adminCompetitions({ view, q });
  return (
    <ConsolePage>
      <ConsoleTopbar crumbs={[{ label: t.console.nav.home, href: '/admin/overview' }, { label: a.title }]} />
      <div className="console-body">
        <PageHead title={a.title} lede={a.lede} />
        <section className="card">
          <div className="flex flex-wrap items-center gap-3 p-4">
            <nav className="flex gap-2" aria-label={a.title}>
              {VIEWS.map((key) => (
                <Link key={key} href={`/admin/competitions?view=${key}${q ? `&q=${encodeURIComponent(q)}` : ''}`} className={`btn sm ${view === key ? '' : 'ghost'}`} aria-current={view === key ? 'page' : undefined}>
                  {a.views[key]}
                </Link>
              ))}
            </nav>
            <form action="/admin/competitions" className="ml-auto flex gap-2">
              <input type="hidden" name="view" value={view} />
              <input name="q" defaultValue={q} placeholder={a.search} aria-label={a.search} className="input sm" />
            </form>
          </div>
          <AdminCompetitionsTable rows={rows} />
        </section>
      </div>
    </ConsolePage>
  );
}
