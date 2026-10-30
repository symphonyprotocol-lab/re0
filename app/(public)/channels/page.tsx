import type { Metadata } from 'next';
import Link from 'next/link';
import { SectionHeading } from '@/components/ui/primitives';
import { ChannelGrid } from '@/components/site/channel-grid';
import { ClockIcon, SparklesIcon } from '@/components/ui/icons';
import { DIRECTORY_PAGE_SIZE, listChannelDirectory } from '@/lib/application/channels';
import { isDirectorySort, type DirectorySort } from '@/lib/domain/channel';
import { fill } from '@/lib/i18n/format';
import { getMessages, translations } from '@/lib/i18n/server';

type Search = { searchParams: Promise<{ sort?: string; page?: string }> };

/** A later page names itself; the sort is the same channels in another order, so the canonical leaves it off. */
export async function generateMetadata({ searchParams }: Search): Promise<Metadata> {
  const [{ page }, { channels: c }] = await Promise.all([searchParams, getMessages()]);
  const pageNumber = Number.parseInt(page ?? '1', 10);
  const canonical = Number.isFinite(pageNumber) && pageNumber > 1 ? `/channels?page=${pageNumber}` : '/channels';
  return { title: c.metaTitle, description: c.metaDescription, alternates: { canonical }, openGraph: { url: canonical } };
}

function directoryHref(sort: DirectorySort, page: number): string {
  const params = new URLSearchParams();
  if (sort === 'recent') params.set('sort', 'recent');
  if (page > 1) params.set('page', String(page));
  const qs = params.toString();
  return qs ? `/channels?${qs}` : '/channels';
}

/**
 * The channel directory (agent-first-proposal.md 6.4): public channels with
 * at least one live asset, never a suspended, private or empty one. 热门
 * (default) and 最近更新; single assets are not listed here, a channel is
 * the unit.
 */
export default async function ChannelDirectoryPage({ searchParams }: Search) {
  const [{ sort: sortParam, page: pageParam }, { locale, t }] = await Promise.all([searchParams, translations()]);
  const c = t.channels;
  const sort: DirectorySort = isDirectorySort(sortParam) ? sortParam : 'hot';
  const page = Math.max(1, Number.parseInt(pageParam ?? '1', 10) || 1);
  const { entries, total } = await listChannelDirectory({
    sort,
    limit: DIRECTORY_PAGE_SIZE,
    offset: (page - 1) * DIRECTORY_PAGE_SIZE,
  });
  const pages = Math.max(1, Math.ceil(total / DIRECTORY_PAGE_SIZE));
  const tab = (value: DirectorySort, label: string, Icon: typeof SparklesIcon) => (
    <Link
      href={directoryHref(value, 1)}
      className={`flex h-10 items-center gap-2 rounded-full px-4 text-caption ${
        sort === value ? 'bg-brandsoft font-medium text-ink' : 'text-muted transition-colors hover:text-ink'
      }`}
      aria-current={sort === value ? 'page' : undefined}
    >
      <Icon size={15} />
      {label}
    </Link>
  );

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-8 px-5 pt-16 pb-20">
      <SectionHeading as="h1" size="lg" eyebrow={c.eyebrow} title={c.title} />
      <p className="-mt-4 max-w-[70ch] text-body text-muted">{c.lede}</p>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          {tab('hot', c.sortHot, SparklesIcon)}
          {tab('recent', c.sortRecent, ClockIcon)}
        </div>
        <p className="text-caption text-muted">
          {fill(c.totalLine, { total: String(total) })} · {sort === 'hot' ? c.sortedHot : c.sortedRecent}
        </p>
      </div>

      {entries.length > 0 ? (
        <ChannelGrid entries={entries} locale={locale} />
      ) : (
        <p className="rounded-md border border-dashed border-line px-5 py-12 text-center text-caption text-muted">{c.empty}</p>
      )}

      {pages > 1 ? (
        <nav className="flex items-center justify-center gap-3 text-caption">
          {page > 1 ? (
            <Link href={directoryHref(sort, page - 1)} className="rounded-md border border-line px-3 py-1.5 text-ink hover:bg-subtle">
              {c.previous}
            </Link>
          ) : null}
          <span className="text-muted">
            {page} / {pages}
          </span>
          {page < pages ? (
            <Link href={directoryHref(sort, page + 1)} className="rounded-md border border-line px-3 py-1.5 text-ink hover:bg-subtle">
              {c.next}
            </Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
