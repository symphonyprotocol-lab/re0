import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CopyButton } from '@/components/dashboard/copy-button';
import {
  ActionButton,
  Badge,
  ListHeader,
  Notice,
  PANEL,
  PageHeader,
  StatTile,
} from '@/components/dashboard/ui';
import { ArrowUpRightIcon, EyeIcon, GlobeIcon, MailIcon, MessagesSquareIcon, SparklesIcon } from '@/components/ui/icons';
import { listWorkspaceShowcases } from '@/lib/application/showcase';
import { countWorkspaceLibraries } from '@/lib/application/libraries';
import { showcasePath } from '@/lib/domain/showcase';
import { configuredBaseUrl } from '@/lib/http/base-url';
import { surfaceEnabled } from '@/lib/domain/surfaces';
import { requireSession } from '@/lib/http/session';
import { fill } from '@/lib/i18n/format';
import { getMessages, translations } from '@/lib/i18n/server';
import { PUBLIC_ORIGIN } from '@/lib/site/origin';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getMessages()).dashboard.showcases.metaTitle };
}

const GRID = 'grid grid-cols-[minmax(0,1.4fr)_110px_minmax(0,1.6fr)_150px_90px_90px] items-center gap-2.5';

/**
 * The workspace's shared pages in one place (lib/domain/showcase.ts): one
 * row per page -- a library without one is not listed -- with where it
 * stands, its address and the last thirty days of visitors, questions and
 * leads. Pages are made
 * and edited on each library's page; this screen is the view across all
 * of them and the way to the one that needs attention.
 */
export default async function DashboardShowcasesPage() {
  /* agent-first-proposal.md 3.6: the surface is offline; its screen is not served. */
  if (!surfaceEnabled('showcase')) notFound();
  const [session, { locale, t }] = await Promise.all([requireSession('/dashboard/showcases'), translations()]);
  const w = t.dashboard.showcases;
  const s = t.dashboard.libraryDetail.showcase;
  const [overview, libraryCount] = await Promise.all([
    listWorkspaceShowcases(session.workspace.id),
    countWorkspaceLibraries(session.workspace.id),
  ]);
  const number = new Intl.NumberFormat(locale);
  const origin = configuredBaseUrl() ?? PUBLIC_ORIGIN;
  const addressOf = (page: (typeof overview.rows)[number]['page']) =>
    page.customHost ? `https://${page.customHost}/` : `${origin}${showcasePath(page.slug)}`;

  const stats = [
    { key: 'published', value: number.format(overview.published), label: w.stats.published, Icon: GlobeIcon },
    { key: 'views', value: number.format(overview.views), label: fill(w.stats.views, { days: overview.days }), Icon: EyeIcon },
    { key: 'questions', value: number.format(overview.questions), label: fill(w.stats.questions, { days: overview.days }), Icon: MessagesSquareIcon },
    { key: 'leads', value: number.format(overview.unhandledLeads), label: w.stats.leads, Icon: MailIcon },
  ];

  const action =
    libraryCount === 0 ? (
      <ActionButton href="/dashboard/assets/new">{w.createLibrary}</ActionButton>
    ) : (
      <ActionButton href="/dashboard/assets" variant={overview.published > 0 ? 'outline' : 'primary'}>
        {w.pickLibrary}
      </ActionButton>
    );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader eyebrow={session.workspace.name} title={w.title} description={w.description} action={action} />

      <section className="grid grid-cols-2 gap-[9px] sm:grid-cols-4">
        {stats.map(({ key, value, label, Icon }) => (
          <StatTile key={key} icon={<Icon size={17} />} value={value} label={label} />
        ))}
      </section>

      <Notice tone="brand" icon={<SparklesIcon size={18} />} title={w.tip.title} body={w.tip.body} />

      <section className={`${PANEL} overflow-hidden p-0.5`}>
        <ListHeader title={w.list.title} description={fill(w.list.description, { days: overview.days })} />

        {overview.rows.length === 0 ? (
          <p className="border-t border-line px-5 py-10 text-center text-[13px] text-muted">{w.list.empty}</p>
        ) : (
          <div className="overflow-x-auto">
            <div className="min-w-[760px]">
              <div className={`${GRID} border-t border-line bg-subtle px-5 py-[11px] text-[11px] font-medium text-muted`}>
                {w.list.columns.map((column) => (
                  <span key={column}>{column}</span>
                ))}
              </div>
              {overview.rows.map((row) => {
                const manageHref = `/dashboard/assets/${row.libraryId}#showcase`;
                const page = row.page;
                const address = addressOf(page);
                return (
                  <div key={row.libraryId} className={`${GRID} border-t border-line px-5 py-3 text-[12px]`}>
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <Link href={manageHref} className="truncate font-medium text-ink hover:text-brandink">
                        {page.name}
                      </Link>
                      <span className="truncate text-[11px] text-muted">
                        {row.libraryTitle} · {row.libraryPublicId}
                      </span>
                    </span>
                    <span className="flex flex-wrap items-center gap-1">
                      <Badge tone={page.status === 'published' ? 'public' : 'neutral'}>{s.status[page.status]}</Badge>
                      {page.expired ? <Badge tone="private">{s.statusExpired}</Badge> : null}
                      {page.hasPassword && !page.expired ? <Badge tone="neutral">{s.statusLocked}</Badge> : null}
                    </span>
                    <span className="flex min-w-0 items-center gap-1.5">
                      <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-steel">{address}</code>
                      <CopyButton value={address} label={w.list.copy} className="shrink-0 text-muted hover:bg-mutedbg" />
                      {page.status === 'published' ? (
                        <a
                          href={address}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={w.list.open}
                          className="inline-flex size-[30px] shrink-0 items-center justify-center rounded-md text-muted hover:bg-mutedbg"
                        >
                          <ArrowUpRightIcon size={15} />
                        </a>
                      ) : null}
                    </span>
                    <span className="text-[11.5px] text-steel">
                      {fill(w.list.stats, { views: number.format(row.views), questions: number.format(row.questions) })}
                    </span>
                    <span>
                      {row.unhandledLeads > 0 ? (
                        <Link href={manageHref} className="inline-flex">
                          <Badge tone="public">{fill(w.list.leadsUnhandled, { n: number.format(row.unhandledLeads) })}</Badge>
                        </Link>
                      ) : (
                        <span className="text-[11.5px] text-muted">{number.format(row.leads)}</span>
                      )}
                    </span>
                    <span>
                      <Link
                        href={manageHref}
                        className="inline-flex h-8 items-center rounded-md border border-line bg-card px-3 text-[11.5px] font-medium text-ink hover:bg-subtle"
                      >
                        {w.list.manage}
                      </Link>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
