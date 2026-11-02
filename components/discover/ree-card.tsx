'use client';

import Link from 'next/link';
import { QUERY_BASE_FEE } from '@/lib/constants';
import type { ReeCard as Card } from '@/lib/services/explore';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber } from '@/i18n/format';
import { Icon } from '@/components/ui/icons';
import { ReeAvatar } from '@/components/ui/ree-avatar';
import { RoleBadge } from '@/components/discover/role-badge';

const COVERS: Record<string, string> = {
  default: 'from-[#e8f2ff] to-[#f5f3ff]',
  lilac: 'from-[#f1ecff] to-[#faf7ff]',
  sand: 'from-[#fbf3e6] to-[#fffaf2]',
  sage: 'from-[#e9f5ef] to-[#f6fbf8]',
  rose: 'from-[#fdebef] to-[#fff6f8]',
  slate: 'from-[#eceff5] to-[#f7f8fb]',
};

/** The 16:9 cover without a video (step 7 adds the player): the Ree's avatar and name on its colour. */
export function ReeCover({ ree, className = '' }: { ree: Pick<Card, 'name' | 'avatarBlob' | 'color'>; className?: string }) {
  const { t } = useI18n();
  return (
    <span className={`relative flex aspect-video w-full flex-col items-center justify-center gap-2 overflow-hidden bg-gradient-to-br ${COVERS[ree.color] ?? COVERS.default} ${className}`}>
      <ReeAvatar avatar={ree.avatarBlob} color={ree.color} size="lg" />
      <strong className="max-w-[85%] truncate text-[13px] text-ink">{ree.name}</strong>
      <small className="flex items-center gap-1 text-[10px] text-muted">
        <Icon name="film" className="size-3" />
        {t.discover.card.noVideo}
      </small>
    </span>
  );
}

/**
 * An explore result (prototype app.js `dotCard`, 2.4 step 4): the card is
 * the way in -- cover and name open the public page, the search carried in
 * `from` -- with no input and no button. Introduction, the owner and their
 * role, the matched passage when there is a question, source count, price,
 * answers and helpful share.
 */
export function ReeCardView({ ree, from }: { ree: Card; from: string }) {
  const { t, locale } = useI18n();
  const c = t.discover.card;
  const n = (value: number) => formatNumber(value, locale);
  const href = `/r/${ree.slug}${from && from !== '/explore' ? `?from=${encodeURIComponent(from)}` : ''}`;
  return (
    <article className="card flex min-w-0 flex-col overflow-hidden" aria-label={ree.name}>
      <Link href={href} className="block" tabIndex={-1} aria-hidden="true">
        <ReeCover ree={ree} />
      </Link>
      <div className="flex flex-1 flex-col gap-2 p-4">
        <Link href={href} className="flex min-w-0 items-center text-[15px] font-bold hover:text-blue">
          <span className="truncate">{ree.name}</span>
        </Link>
        <p className="line-clamp-2 text-[12px] text-muted">{ree.description}</p>
        {ree.excerpt && <p className="line-clamp-3 rounded-lg border-l-2 border-blue bg-soft px-3 py-2 text-[12px] leading-relaxed text-[#3b4361]">“{ree.excerpt}”</p>}
        <div className="mt-auto flex min-w-0 items-center justify-between gap-2 pt-1 text-[11px] text-muted">
          <span className="flex flex-none items-center gap-1">
            <Icon name="file" className="size-3.5" />
            {fill(c.sources, { n: n(ree.sources) })}
          </span>
          <span className="flex min-w-0 items-center">
            <span className="truncate">{ree.ownerName}</span>
            <RoleBadge role={ree.role} />
          </span>
        </div>
        <div className="flex items-end justify-between gap-2 border-t border-line pt-3">
          <span className="font-mono text-[18px] font-semibold" title={fill(c.priceTitle, { base: QUERY_BASE_FEE, fee: ree.queryFee })}>
            {n(ree.price)}
            <small className="ml-1 font-sans text-[10px] font-normal text-muted">{c.perAnswer}</small>
          </span>
          <div className="flex gap-3 text-right" role="group" aria-label={c.activity}>
            <span>
              <strong className="flex items-center justify-end gap-1 font-mono text-[12px]">
                <Icon name="chat" className="size-3" />
                {n(ree.answers)}
              </strong>
              <small className="text-[10px] text-muted">{c.answers}</small>
            </span>
            <span>
              <strong className="flex items-center justify-end gap-1 font-mono text-[12px]">
                <Icon name="thumbUp" className="size-3" />
                {ree.positiveRate === null ? <span className="font-sans text-[10px] font-normal text-muted">{c.noRating}</span> : `${ree.positiveRate}%`}
              </strong>
              <small className="text-[10px] text-muted">{c.rating}</small>
            </span>
          </div>
        </div>
      </div>
    </article>
  );
}
