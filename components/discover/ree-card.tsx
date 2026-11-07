'use client';

import { QUERY_BASE_FEE } from '@/lib/constants';
import type { ReeCard as Card } from '@/lib/services/explore';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber } from '@/i18n/format';
import { Icon } from '@/components/ui/icons';
import { RoleBadge } from '@/components/discover/role-badge';
import { ReeFavoriteButton } from '@/components/rees/ree-favorite-button';
import { ReeCardCover } from '@/components/rees/ree-card-cover';
import { ReeCardMetrics } from '@/components/discover/ree-card-metrics';
import { VideoPlaceholder } from '@/components/video/video-cover';
import { IntroCoverFrame } from '@/components/video/intro-cover-frame';
import type { IntroProps } from '@/lib/domain/video';
import './ree-video-card.css';

/**
 * A Ree's 16:9 card image, falling back to the intro still or placeholder.
 */
export function ReeCover({ ree }: { ree: Pick<Card, 'name' | 'avatarBlob' | 'color'> & { coverBlob?: string | null; video?: IntroProps | null } }) {
  if (ree.coverBlob) return <img src={`/media/${ree.coverBlob}`} alt="" loading="lazy" className="aspect-video w-full object-cover" />;
  return ree.video ? <IntroCoverFrame video={ree.video} lazy /> : <VideoPlaceholder ree={ree} />;
}

/**
 * An explore result (prototype app.js `dotCard`, 2.4 step 4): the cover is
 * the way in -- it opens the public page, the search carried in `from` --
 * with no input. Introduction, the matched passage when there is a question,
 * source count, the owner and their role, price, answers and helpful share.
 * Styled by explore.css with the prototype's class names.
 */
export function ReeCardView({ ree, from, favorite, viewerId }: { ree: Card; from: string; favorite?: boolean; viewerId?: string }) {
  const { t, locale } = useI18n();
  const c = t.discover.card;
  const n = (value: number) => formatNumber(value, locale);
  const href = `/r/${ree.slug}${from && from !== '/explore' ? `?from=${encodeURIComponent(from)}` : ''}`;
  return (
    <article className="dot-card discovery-card ree-video-card" aria-label={ree.name}>
      <ReeCardCover ree={ree} href={href} label={fill(c.view, { name: ree.name })} video={ree.video} />
      <div className="ree-card-info">
        <div className="flex items-start gap-2">
          <p className="description min-w-0 flex-1">{ree.description}</p>
          {ree.ownerId !== viewerId && <ReeFavoriteButton ree={ree} favorite={favorite} returnTo={from || '/explore'} />}
        </div>
        {ree.excerpt && <p className="match-excerpt">“{ree.excerpt}”</p>}
        <div className="dot-sources">
          <Icon name="file" />
          {fill(c.sources, { n: n(ree.sources) })}
          <span className="discovery-author">
            {ree.ownerName}
            <RoleBadge role={ree.role} />
          </span>
        </div>
        <div className="card-actions">
          <span className="price" title={fill(c.priceTitle, { base: QUERY_BASE_FEE, fee: ree.queryFee })}>
            {n(ree.price)}
            <small>{c.perAnswer}</small>
          </span>
          <ReeCardMetrics answers={ree.answers} positiveRate={ree.positiveRate} />
        </div>
      </div>
    </article>
  );
}
