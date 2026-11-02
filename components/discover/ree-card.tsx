'use client';

import Link from 'next/link';
import { QUERY_BASE_FEE } from '@/lib/constants';
import type { ReeCard as Card } from '@/lib/services/explore';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber } from '@/i18n/format';
import { Icon } from '@/components/ui/icons';
import { RoleBadge } from '@/components/discover/role-badge';
import { PlayIntroButton, VideoPlaceholder, VideoPoster } from '@/components/video/video-cover';
import type { IntroProps } from '@/lib/domain/video';

/**
 * The 16:9 cover (step 7): the introduction's opening still when the Ree has
 * one, the shared "暂无视频介绍" placeholder otherwise.
 */
export function ReeCover({ ree, className = '' }: { ree: Pick<Card, 'name' | 'avatarBlob' | 'color'> & { video?: IntroProps | null }; className?: string }) {
  return ree.video ? <VideoPoster ree={ree} video={ree.video} className={className} /> : <VideoPlaceholder ree={ree} className={className} />;
}

/**
 * An explore result (prototype app.js `dotCard`, 2.4 step 4): the card is
 * the way in -- cover and name open the public page, the search carried in
 * `from` -- with no input; a Ree with an introduction gets a play button on
 * its cover (step 7). Introduction, the owner and their
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
      <div className="relative">
        <Link href={href} className="block" tabIndex={-1} aria-hidden="true">
          <ReeCover ree={ree} />
        </Link>
        {/* Step 7 (8.4 "explore 卡片 16:9 封面与播放弹窗"): the cover opens the page, this plays the 15 seconds here. */}
        {ree.video && <PlayIntroButton video={ree.video} name={ree.name} href={href} linkLabel={t.video.dialog.details} className="absolute top-3 right-3" />}
      </div>
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
