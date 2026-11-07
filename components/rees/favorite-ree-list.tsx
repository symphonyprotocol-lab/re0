import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { ReeFavoriteButton } from '@/components/rees/ree-favorite-button';
import { Icon } from '@/components/ui/icons';
import { ReeAvatar } from '@/components/ui/ree-avatar';
import { fill, formatNumber } from '@/i18n/format';
import { serverMessages } from '@/i18n/server';
import type { listFavoriteRees } from '@/lib/services/ree-favorites';

export function favoriteReesHref(page = 1): string {
  return page > 1 ? `/rees?tab=favorites&page=${page}` : '/rees?tab=favorites';
}

export async function FavoriteReeList({ result }: {
  result: Awaited<ReturnType<typeof listFavoriteRees>>;
}) {
  const { t, locale } = await serverMessages();
  const r = t.rees;
  const f = r.favorite;
  const n = (value: number) => formatNumber(value, locale);
  const pages = Math.max(1, Math.ceil(result.total / result.size));
  return (
    <main className="mx-auto w-full max-w-[1120px] px-4 py-6 sm:px-7 sm:py-8">
      <header>
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-[26px] font-extrabold sm:text-[30px]">{r.tabs.favorites}</h1>
          <span className="rounded-full bg-soft px-2.5 py-0.5 text-[12px] font-semibold text-blue" aria-label={fill(r.total, { total: n(result.total) })}>
            {n(result.total)}
          </span>
        </div>
        <p className="mt-1 text-[13px] text-muted">{f.lede}</p>
      </header>
      {result.items.length ? (
        <>
          <div className="mt-5 mb-2 flex items-center gap-1.5 text-[12px] text-muted">
            <Icon name="clock" className="size-3.5" />
            {f.newest}
          </div>
          <ul className="card divide-y divide-line" aria-label={r.tabs.favorites}>
            {result.items.map(ree => (
              <li key={ree.id} className="flex items-center gap-2 px-3 py-3 sm:gap-4 sm:px-5">
                <Link href={`/r/${ree.slug}`} className="flex min-w-0 flex-1 items-start gap-3 hover:text-blue">
                  <ReeAvatar avatar={ree.avatarBlob} color={ree.color} />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <strong className="text-[14px] [overflow-wrap:anywhere]">{ree.name}</strong>
                      <span className="text-[11px] text-muted [overflow-wrap:anywhere]">{fill(f.by, { name: ree.ownerName })}</span>
                    </div>
                    {ree.description && <p className="mt-0.5 line-clamp-2 text-[12px] text-muted [overflow-wrap:anywhere]">{ree.description}</p>}
                  </div>
                </Link>
                <ReeFavoriteButton ree={ree} favorite returnTo={favoriteReesHref(result.page)} />
              </li>
            ))}
          </ul>
          {pages > 1 && (
            <nav aria-label={f.pagination} className="mt-4 flex flex-wrap items-center justify-between gap-2 text-[12px] text-muted">
              <span>{fill(r.pager.page, { n: n(result.page) })} / {n(pages)}</span>
              <div className="flex items-center gap-2">
                {result.page > 1 && <Link href={favoriteReesHref(result.page - 1)} className="btn-secondary btn-sm">{r.pager.previous}</Link>}
                {result.page < pages && <Link href={favoriteReesHref(result.page + 1)} className="btn-secondary btn-sm">{r.pager.next}</Link>}
              </div>
            </nav>
          )}
        </>
      ) : (
        <section className="card mt-6 flex flex-col items-center px-5 py-10 text-center">
          <span className="grid size-11 place-items-center rounded-xl bg-soft text-blue"><Icon name="bookmark" /></span>
          <h2 className="mt-3 text-[16px] font-semibold">{f.emptyTitle}</h2>
          <p className="mt-1 text-[13px] text-muted">{f.emptyBody}</p>
          <Link href="/explore" className="btn btn-sm mt-4">{t.discover.nav}<Icon name="arrow" className="size-3.5" /></Link>
        </section>
      )}
    </main>
  );
}
