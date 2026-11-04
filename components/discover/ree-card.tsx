'use client';

import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import type { CSSProperties } from 'react';
import { QUERY_BASE_FEE } from '@/lib/constants';
import type { ReeCard as Card } from '@/lib/services/explore';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber } from '@/i18n/format';
import { Icon } from '@/components/ui/icons';
import { ReeAvatar } from '@/components/ui/ree-avatar';
import { RoleBadge } from '@/components/discover/role-badge';
import { ReeCardMetrics } from '@/components/discover/ree-card-metrics';
import { PlayIntroButton, VideoPlaceholder, VideoPoster } from '@/components/video/video-cover';
import type { IntroProps } from '@/lib/domain/video';
import './ree-video-card.css';

/**
 * The 16:9 cover (step 7): the introduction's opening still when the Ree has
 * one, the shared "暂无视频介绍" placeholder otherwise.
 */
export function ReeCover({ ree, className = '' }: { ree: Pick<Card, 'name' | 'avatarBlob' | 'color'> & { video?: IntroProps | null }; className?: string }) {
  return ree.video ? <VideoPoster ree={ree} video={ree.video} className={className} /> : <VideoPlaceholder ree={ree} className={className} />;
}

/**
 * An explore result's 16:9 cover (prototype suite.js `discoveryCover`): the
 * introduction's opening shot in its template, or the "暂无视频介绍"
 * placeholder; either way a link to the public page. 含视频介绍 plays the
 * introduction here (step 7, 8.4).
 */
function DiscoveryCover({ ree, href }: { ree: Card; href: string }) {
  const { t } = useI18n();
  const video = ree.video;
  const view = fill(t.discover.card.view, { name: ree.name });
  return (
    <div
      className={`discovery-cover template-${video?.template ?? 'editorial'}${video ? '' : ' is-video-placeholder'}`}
      style={{ '--video-accent': video?.accent ?? '#127ee3' } as CSSProperties}
    >
      {video ? (
        <>
          <Link href={href} className="discovery-cover-poster" aria-label={view}>
            <span className="discovery-cover-kicker">MEET YOUR KNOWLEDGE COMPANION</span>
            <span className="discovery-cover-identity">
              <ReeAvatar avatar={ree.avatarBlob} color={ree.color} className="dot-avatar" />
              <strong>{video.scenes.opening.name}</strong>
            </span>
            <span className="discovery-cover-tagline">{video.scenes.opening.position}</span>
            <span className="discovery-cover-duration">00:15</span>
          </Link>
          <PlayIntroButton video={video} name={ree.name} href={href} linkLabel={t.video.dialog.details} label={t.video.card.has} icon="film" className="discovery-cover-label" />
        </>
      ) : (
        <Link href={href} className="discovery-cover-poster is-static is-video-placeholder" aria-label={view}>
          <div className="public-dot-video-placeholder" role="img" aria-label={`${ree.name}: ${t.video.placeholder.none}`}>
            <span className="public-dot-video-placeholder-brand" aria-hidden="true">
              RE0 <span>YOUR KNOWLEDGE. A NEW VOICE.</span>
            </span>
            <div>
              <ReeAvatar avatar={ree.avatarBlob} color={ree.color} className="dot-avatar" />
              <strong>{ree.name}</strong>
              <span className="public-dot-video-placeholder-status">
                <Icon name="film" />
                {t.video.placeholder.none}
              </span>
            </div>
            <span className="public-dot-video-placeholder-caption" aria-hidden="true">
              {t.video.placeholder.caption}
            </span>
          </div>
        </Link>
      )}
    </div>
  );
}

/**
 * An explore result (prototype app.js `dotCard`, 2.4 step 4): the cover is
 * the way in -- it opens the public page, the search carried in `from` --
 * with no input. Introduction, the matched passage when there is a question,
 * source count, the owner and their role, price, answers and helpful share.
 * Styled by explore.css with the prototype's class names.
 */
export function ReeCardView({ ree, from }: { ree: Card; from: string }) {
  const { t, locale } = useI18n();
  const c = t.discover.card;
  const n = (value: number) => formatNumber(value, locale);
  const href = `/r/${ree.slug}${from && from !== '/explore' ? `?from=${encodeURIComponent(from)}` : ''}`;
  return (
    <article className="dot-card discovery-card ree-video-card" aria-label={ree.name}>
      <DiscoveryCover ree={ree} href={href} />
      <div className="ree-card-info">
        <p className="description">{ree.description}</p>
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
