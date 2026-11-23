'use client';

import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { QUERY_BASE_FEE } from '@/lib/constants';
import { PUBLIC_QA_ASK_ANCHOR } from '@/lib/domain/public-qa';
import type { ReeCard } from '@/lib/services/explore';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber, formatRelative } from '@/i18n/format';
import { Icon } from '@/components/ui/icons';
import { ReeAvatar } from '@/components/ui/ree-avatar';
import { useToast } from '@/components/ui/toast';
import { RoleBadge } from '@/components/discover/role-badge';
import { ReeCover } from '@/components/discover/ree-card';
import { ReeFavoriteButton } from '@/components/rees/ree-favorite-button';
import './feed.css';

/** A new Ree says when it was listed for this long; older ones only say when they last answered. */
const LISTED_FOR_MS = 30 * 86_400_000;

/**
 * One Ree in explore's feed (docs/design/discover-feed.html, v3): the Ree
 * itself, never a question or answer. Avatar, name, author and role, when
 * it last answered someone, introduction, category and price, its cover,
 * this week's activity, then answers, rating, favourite, share and 提问 --
 * which opens the Ree page at its question box. The whole item opens the
 * Ree page, as the card's cover did.
 */
export function FeedRee({ ree, from, favorite, viewerId, pinned = false, now }: {
  ree: ReeCard;
  /** The list this item is in: where saving it while signed out comes back to. */
  from: string;
  favorite?: boolean;
  viewerId?: string;
  pinned?: boolean;
  /** When the page was rendered, so "N 小时前" agrees between server and browser. */
  now: number;
}) {
  const { t, locale } = useI18n();
  const c = t.discover.card;
  const toast = useToast();
  const n = (value: number) => formatNumber(value, locale);
  /* The bare page: the way back to the list travels outside the URL (public-visit.tsx). */
  const href = `/r/${ree.slug}`;
  const category = t.common.categories[ree.category as keyof typeof t.common.categories] ?? ree.category;
  const createdAt = new Date(ree.createdAt);
  const time = ree.lastAnsweredAt
    ? fill(c.answeredAgo, { time: formatRelative(ree.lastAnsweredAt, now, locale, t.discover.public.qa.justNow) })
    : now - createdAt.getTime() < LISTED_FOR_MS
      ? fill(c.listedAgo, { time: formatRelative(createdAt, now, locale, t.discover.public.qa.justNow) })
      : null;

  async function share() {
    await navigator.clipboard.writeText(`${window.location.origin}/s/${ree.slug}`).then(() => toast(c.shareCopied), () => toast(t.common.errors.generic));
  }

  return (
    <article className="feed-ree" aria-label={ree.name}>
      {pinned && (
        <div className="feed-ree-pin">
          <Icon name="pin" className="" />
          {c.pinned}
        </div>
      )}
      <div className="feed-ree-avatar">
        <ReeAvatar avatar={ree.avatarBlob} color={ree.color} size="md" />
      </div>
      <div className="feed-ree-body">
        <div className="feed-ree-head">
          <Link href={href} className="feed-ree-name" aria-label={fill(c.view, { name: ree.name })}>
            {ree.name}
          </Link>
        </div>
        <div className="feed-ree-head">
          <span className="discovery-author">
            {ree.ownerName}
            <RoleBadge role={ree.role} />
          </span>
          {time && (
            <>
              <span aria-hidden="true">·</span>
              <span className="feed-ree-time">{time}</span>
            </>
          )}
        </div>
        <p className="feed-ree-desc">{ree.description}</p>
        {ree.excerpt && <p className="match-excerpt">“{ree.excerpt}”</p>}
        <div className="feed-ree-tags">
          <span className="tag">{category}</span>
          <span className="tag" title={fill(c.priceTitle, { base: QUERY_BASE_FEE, fee: ree.queryFee })}>
            {n(ree.price)} {c.perAnswer}
          </span>
        </div>
        <div className="feed-ree-media">
          <div className="ree-identity-cover">
            <ReeCover ree={ree} />
          </div>
        </div>
        <div className="feed-ree-pulse">
          {ree.asked7 > 0 && <span className="feed-ree-live">{fill(c.weekQuestions, { n: n(ree.asked7) })}</span>}
          <span>{ree.publicQa > 0 ? fill(c.publicQa, { n: n(ree.publicQa) }) : c.noPublicQa}</span>
          <span className="inline-flex items-center gap-1">
            <Icon name="file" className="size-[11px]" />
            {fill(c.sources, { n: n(ree.sources) })}
          </span>
        </div>
        <div className="feed-ree-actions">
          <span className="icon-btn" title={c.answers}>
            <Icon name="chat" className="" />
            <span className="feed-ree-count">{n(ree.answers)}</span>
            <span className="sr-only">{c.answers}</span>
          </span>
          <span className="icon-btn" title={c.rating}>
            <Icon name="thumbUp" className="" />
            <span className="feed-ree-count">{ree.positiveRate === null ? c.noRating : `${ree.positiveRate}%`}</span>
            <span className="sr-only">{c.rating}</span>
          </span>
          {ree.ownerId !== viewerId && <ReeFavoriteButton ree={ree} favorite={favorite} returnTo={from || '/explore'} />}
          <button type="button" className="icon-btn" aria-label={c.share} title={c.share} onClick={() => void share()}>
            <Icon name="share" className="" />
          </button>
          <Link href={`${href}#${PUBLIC_QA_ASK_ANCHOR}`} className="btn secondary feed-ree-ask" aria-label={fill(c.askTitle, { name: ree.name })}>
            <Icon name="chat" className="" />
            {c.ask}
          </Link>
        </div>
      </div>
    </article>
  );
}
