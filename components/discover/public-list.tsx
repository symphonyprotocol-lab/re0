'use client';

import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import type { PublicList } from '@/lib/services/public-rees';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber } from '@/i18n/format';
import { Icon } from '@/components/ui/icons';
import { ReeCover } from '@/components/discover/ree-card';
import { RoleBadge } from '@/components/discover/role-badge';
import { ReeFavoriteButton } from '@/components/rees/ree-favorite-button';

/** "相关 Rees" / "作者的其他 Rees" (prototype public-dot.js `recommendationGroup`): four a page, each group paged on its own. */
export function PublicListSection({
  kind,
  list,
  title,
  body,
  empty,
  previousHref,
  nextHref,
  from,
  returnTo,
  favoriteIds,
  viewerId,
}: {
  kind: 'related' | 'author';
  list: PublicList;
  title: string;
  body: string;
  empty: string;
  previousHref: string;
  nextHref: string;
  from: string;
  returnTo: string;
  favoriteIds?: string[];
  viewerId?: string;
}) {
  const { t, locale } = useI18n();
  const p = t.discover.public;
  const n = (value: number) => formatNumber(value, locale);
  return (
    <section className="card p-5" data-ree-group={kind} aria-labelledby={`public-${kind}-heading`}>
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id={`public-${kind}-heading`} className="flex items-center gap-2 text-[16px] font-bold">
            <Icon name={kind === 'related' ? 'compass' : 'users'} className="size-4 text-blue" />
            {title}
          </h2>
          <p className="mt-1 text-[12px] text-muted">{body}</p>
        </div>
        <span className="text-[11px] text-muted">{fill(p.count, { n: n(list.total) })}</span>
      </header>
      {list.total === 0 ? (
        <p className="mt-4 rounded-lg bg-wash px-3 py-4 text-center text-[12px] text-muted">{empty}</p>
      ) : (
        <ul className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {list.items.map((ree) => {
            const href = `/r/${ree.slug}${from !== '/explore' ? `?from=${encodeURIComponent(from)}` : ''}`;
            return (
              <li key={ree.id} className="group relative min-w-0 overflow-hidden rounded-xl border border-line bg-white transition-[scale,box-shadow] has-[>div>a>.workspace-link-progress[data-pending=true]]:scale-[0.985] has-[>div>a>.workspace-link-progress[data-pending=true]]:ring-2 has-[>div>a>.workspace-link-progress[data-pending=true]]:ring-[#c5dcf8]">
                <ReeCover ree={ree} />
                <div className="flex items-start gap-1.5 p-3">
                  {/* One link per Ree; its ::after covers the whole card (the link is unpositioned so the li holds it). */}
                  <Link
                    href={href}
                    className="static! block min-w-0 flex-1 group-hover:text-blue after:absolute after:inset-0 after:z-0 after:content-['']"
                  >
                    <strong className="flex min-w-0 items-center text-[13px]">
                      <span className="truncate">{ree.name}</span>
                    </strong>
                    <p className="mt-1 line-clamp-2 text-[11px] text-muted">{ree.description}</p>
                    <span className="mt-2 flex flex-wrap items-center gap-x-2 text-[10px] text-muted">
                      <span className="flex items-center">
                        {ree.ownerName}
                        <RoleBadge role={ree.role} />
                      </span>
                      <span>{fill(p.successfulAnswers, { n: n(ree.answers) })}</span>
                      <span>{ree.positiveRate === null ? p.noRating : fill(p.positive, { n: ree.positiveRate })}</span>
                    </span>
                  </Link>
                  {ree.ownerId !== viewerId && (
                    <span className="relative z-10 shrink-0">
                      <ReeFavoriteButton ree={ree} favorite={favoriteIds?.includes(ree.id)} returnTo={returnTo} />
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {list.pages > 1 && (
        <nav className="mt-4 flex items-center justify-between text-[11px] text-muted" aria-label={title}>
          <span>
            {n((list.page - 1) * 4 + 1)}–{n(Math.min(list.page * 4, list.total))} / {n(list.total)}
          </span>
          <span className="flex items-center gap-2">
            {list.page > 1 ? (
              <Link scroll={false} href={previousHref} className="icon-btn" aria-label={fill(p.groupPrevious, { group: title })}>
                <Icon name="chevronLeft" />
              </Link>
            ) : (
              <span className="icon-btn opacity-40" aria-disabled="true">
                <Icon name="chevronLeft" />
              </span>
            )}
            <span className="font-mono">
              {list.page} / {list.pages}
            </span>
            {list.page < list.pages ? (
              <Link scroll={false} href={nextHref} className="icon-btn" aria-label={fill(p.groupNext, { group: title })}>
                <Icon name="chevronRight" />
              </Link>
            ) : (
              <span className="icon-btn opacity-40" aria-disabled="true">
                <Icon name="chevronRight" />
              </span>
            )}
          </span>
        </nav>
      )}
    </section>
  );
}
