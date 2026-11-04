'use client';

import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import type { PublicList } from '@/lib/services/public-rees';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber } from '@/i18n/format';
import { Icon } from '@/components/ui/icons';
import { ReeCover } from '@/components/discover/ree-card';
import { RoleBadge } from '@/components/discover/role-badge';

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
}: {
  kind: 'related' | 'author';
  list: PublicList;
  title: string;
  body: string;
  empty: string;
  previousHref: string;
  nextHref: string;
  from: string;
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
              <li key={ree.id} className="min-w-0 overflow-hidden rounded-xl border border-line bg-white">
                <Link href={href} className="block" tabIndex={-1} aria-hidden="true">
                  <ReeCover ree={ree} />
                </Link>
                <Link href={href} className="block p-3 hover:text-blue">
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
