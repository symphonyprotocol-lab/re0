'use client';

import { useEffect, useState } from 'react';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { QUERY_BASE_FEE } from '@/lib/constants';
import { publicTags } from '@/lib/domain/explore';
import { askOption } from '@/lib/domain/post';
import { REE_COMMENTS_ANCHOR, type ReeCommentPage } from '@/lib/domain/ree-comment';
import type { PublicList, PublicRee } from '@/lib/services/public-rees';
import { fill, formatNumber } from '@/i18n/format';
import { Topbar } from '@/components/shell/topbar';
import { FeedColumns } from '@/components/shell/feed-columns';
import { Icon } from '@/components/ui/icons';
import { ReeAvatar } from '@/components/ui/ree-avatar';
import { useToast } from '@/components/ui/toast';
import { ReeIdentityCover } from '@/components/rees/ree-identity-cover';
import { RoleBadge } from '@/components/discover/role-badge';
import { AuthorProfile } from '@/components/discover/author-profile';
import { composeHref } from '@/components/posts/composer';
import { REE_ASK_ANCHOR, ReeAsk } from '@/components/posts/ree-ask';
import { ReePostList, type ReePostPage } from '@/components/posts/ree-posts';
import { PublicListSection } from '@/components/discover/public-list';
import { PublicVisit } from '@/components/discover/public-visit';
import { ReeComments } from '@/components/discover/ree-comments';
import { ReeFavoriteButton } from '@/components/rees/ree-favorite-button';
import { PublicIntro } from '@/components/video/public-intro';
import { useI18n } from '@/i18n/client';
import { useReePreviewDraft } from '@/lib/client/ree-preview';
import type { IntroProps } from '@/lib/domain/video';
import '@/components/discover/feed.css';
import '@/components/ui/tabs.css';

type Search = Record<string, string | string[] | undefined>;
type Tab = 'qa' | 'comments' | 'intro';

function one(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

/** How many related Rees the side column lists before "查看更多". */
const RELATED_SHOWN = 3;

/**
 * `/r/[slug]` and the owner's preview: the Ree's profile on top (cover and
 * avatar, name, introduction, tags, author, figures), then three tabs --
 * 回答的帖子 (向 {name} 提问, the box that names it and posts publicly or
 * asks privately, then the public posts it answered as post cards), 评论
 * and 介绍 (video, what to ask, the author and their other Rees) -- and the
 * "使用这个 Ree" column, whose 向它提问 goes to the box (稿 2, section 6).
 */
export function ReeDetailView({
  savedRee, query, viewerId, preview, draftId, from, related, author, video, comments, posts, favoriteIds, renderedAt,
}: {
  savedRee: PublicRee;
  query: Search;
  viewerId?: string;
  preview: boolean;
  draftId?: string;
  from: string;
  related: PublicList | null;
  author: PublicList | null;
  video: IntroProps | null;
  comments: ReeCommentPage | null;
  posts: ReePostPage | null;
  favoriteIds?: string[];
  renderedAt: number;
}) {
  const { t, locale } = useI18n();
  const p = t.discover.public;
  const q = p.qa;
  const toast = useToast();
  const n = (value: number) => formatNumber(value, locale);
  const result = useReePreviewDraft(draftId, savedRee);
  const draft = result === 'unavailable' ? null : result;
  const queryFee = draft?.fields.queryFee ?? savedRee.queryFee;
  const ree = draft
    ? { ...savedRee, ...draft.fields, queryFee, price: QUERY_BASE_FEE + queryFee }
    : savedRee;
  const coverSrc = draft ? draft.coverSrc : ree.coverBlob ? `/media/${ree.coverBlob}` : null;
  const self = (changes: Record<string, string | number | null>) => {
    const next = new URLSearchParams();
    if (from !== '/explore') next.set('from', from);
    const merged = { ap: author?.page, tab: null as string | null, ...changes };
    if (merged.ap && merged.ap !== 1) next.set('ap', String(merged.ap));
    if (merged.tab) next.set('tab', String(merged.tab));
    return next.size ? `/r/${ree.slug}?${next}` : `/r/${ree.slug}`;
  };
  const ready = ree.sources > 0;
  const category = t.common.categories[ree.category as keyof typeof t.common.categories] ?? ree.category;
  const owner = Boolean(viewerId) && viewerId === ree.ownerId;
  const loginHref = (back: string) => `/login?returnTo=${encodeURIComponent(back)}`;

  /* The tab in the address (`?tab=`, or `#comments` coming back from signing in to comment); the author list's pages open 介绍. */
  const initialTab = (): Tab => {
    const asked = one(query.tab);
    if (asked === 'comments' || asked === 'intro') return asked;
    if (one(query.ap)) return 'intro';
    return 'qa';
  };
  const [tab, setTab] = useState<Tab>(initialTab);
  useEffect(() => {
    if (window.location.hash === `#${REE_COMMENTS_ANCHOR}`) setTab('comments');
  }, []);
  const choose = (next: Tab) => {
    setTab(next);
    window.history.replaceState(window.history.state, '', `${self({ tab: next === 'qa' ? null : next })}`);
  };

  /* 向它提问 (the column's button): the box at the top of 回答的帖子, its question in focus. */
  const goAsk = () => {
    choose('qa');
    requestAnimationFrame(() => {
      const box = document.getElementById(REE_ASK_ANCHOR);
      box?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      box?.querySelector('textarea')?.focus({ preventScroll: true });
    });
  };

  async function share() {
    const url = `${window.location.origin}/s/${ree.slug}`;
    await navigator.clipboard.writeText(url).then(() => toast(p.shareCopied), () => toast(t.common.errors.generic));
  }

  const askBox = preview ? (
    <p className="post-ask rounded-xl border border-line bg-wash px-4 py-3 text-[12px] text-muted">{q.previewNote}</p>
  ) : !ready ? (
    <p className="post-ask rounded-xl border border-line bg-wash px-4 py-3 text-[12px] text-muted">{p.anonymous.noSources}</p>
  ) : (
    <ReeAsk
      ree={{ id: ree.id, slug: ree.slug, name: ree.name }}
      option={askOption(ree, owner)}
      takesPosts={ree.takesPosts}
      signedIn={Boolean(viewerId)}
      loginHref={loginHref(`${self({})}#${REE_ASK_ANCHOR}`)}
    />
  );

  const body = (
          <section className="card ree-profile min-w-0 p-5 sm:p-7" aria-label={ree.name}>
            <header>
              <ReeIdentityCover src={coverSrc} avatar={ree.avatarBlob} color={ree.color} video={video} />
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-[1_1_190px]">
                  <span className="font-mono text-[10px] tracking-[0.18em] text-muted">{p.eyebrow}</span>
                  <h1 className="mt-1 text-[24px] leading-tight font-extrabold tracking-tight break-words sm:text-[28px]">{ree.name}</h1>
                </div>
                {!preview && (
                  <div className="flex shrink-0 items-center gap-1">
                    <button type="button" className="icon-btn" aria-label={p.share} title={p.share} onClick={() => void share()}>
                      <Icon name="share" className="size-4" />
                    </button>
                    {!owner && <ReeFavoriteButton ree={ree} favorite={favoriteIds?.includes(ree.id)} returnTo={self({})} labeled />}
                    {/* v5 "发帖问它": a public post that names this Ree, so it answers first. */}
                    {ree.takesPosts && ready && (viewerId ? (
                      <Link href={composeHref(`/r/${ree.slug}`, self({}).split('?')[1] ?? '', { ree: ree.id, name: ree.name })} className="btn btn-sm" scroll={false}>
                        <Icon name="plus" className="size-3.5" />
                        {t.posts.rees.askIt}
                      </Link>
                    ) : (
                      <Link rel="nofollow" href={loginHref(`/r/${ree.slug}?compose=public&ree=${ree.id}&name=${encodeURIComponent(ree.name)}`)} className="btn btn-sm">
                        <Icon name="plus" className="size-3.5" />
                        {t.posts.rees.askIt}
                      </Link>
                    ))}
                  </div>
                )}
              </div>
              <p className="mt-4 text-[14px] leading-relaxed text-[#3b4361]">{ree.description}</p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Link href={`/explore?category=${ree.category}`} className="tag hover:border-blue hover:text-blue">
                  {category}
                </Link>
                {publicTags(ree.tags, category).map((tag) => (
                  <Link key={tag} href={`/explore?q=${encodeURIComponent(tag)}`} className="tag hover:border-blue hover:text-blue">
                    {tag}
                  </Link>
                ))}
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted">
                <span className="flex items-center">
                  <button type="button" className="hover:text-blue hover:underline" onClick={() => choose('intro')}>{fill(p.by, { name: ree.ownerName })}</button>
                  <RoleBadge role={ree.role} />
                </span>
                <span className="flex items-center gap-1">
                  <Icon name="globe" className="size-3.5" />
                  {p.publicRee}
                </span>
              </div>
              <div className="ree-profile-stats">
                <span><strong>{n(ree.answers)}</strong>{p.answers}</span>
                <span><strong>{ree.positiveRate === null ? '—' : `${ree.positiveRate}%`}</strong>{p.rating}</span>
                <span><strong>{n(posts?.total ?? 0)}</strong>{q.count}</span>
                <span><strong>{n(ree.sources)}</strong>{p.sources}</span>
              </div>
            </header>

            <div className="cl-tabs" role="tablist" aria-label={q.tabs}>
              {([
                ['qa', 'chat', q.tab, posts?.total ?? 0],
                ['comments', 'chat', p.comments.heading, comments?.total ?? 0],
                ['intro', 'info', q.introTab, null],
              ] as const).map(([key, icon, label, count]) => (
                <button key={key} type="button" role="tab" aria-selected={tab === key} className={`cl-tab${tab === key ? ' active' : ''}`} onClick={() => choose(key)}>
                  <Icon name={icon} className="" />
                  {label}
                  {count !== null && <span>{n(count)}</span>}
                </button>
              ))}
            </div>

            <div role="tabpanel" hidden={tab !== 'qa'}>
              {askBox}
              {posts && posts.items.length > 0 ? (
                <div className="mt-4">
                  <ReePostList key={ree.id} reeId={ree.id} initial={posts} signedIn={Boolean(viewerId)} owner={owner} paged renderedAt={renderedAt} />
                </div>
              ) : (
                <div className="ree-qa-empty">
                  <span className="mb-2 grid size-9 place-items-center rounded-lg bg-soft text-blue">
                    <Icon name="chat" className="size-4" />
                  </span>
                  <p className="text-[13px] font-semibold">{ree.publicQaEnabled ? q.emptyTitle : q.closedTitle}</p>
                  <p className="mt-0.5 text-[12px] text-muted">{ree.publicQaEnabled ? q.emptyBody : q.closedBody}</p>
                </div>
              )}
            </div>

            <div role="tabpanel" hidden={tab !== 'comments'} className="mt-5">
              {comments ? (
                <ReeComments
                  key={ree.id}
                  reeId={ree.id}
                  initial={comments}
                  signedIn={Boolean(viewerId)}
                  loginHref={loginHref(`/r/${ree.slug}#${REE_COMMENTS_ANCHOR}`)}
                  renderedAt={renderedAt}
                  embedded
                />
              ) : (
                <p className="text-[12px] text-muted">{q.previewNote}</p>
              )}
            </div>

            <div role="tabpanel" hidden={tab !== 'intro'}>
              {video && (
                <section className="mt-7">
                  <h2 className="flex items-center gap-2 text-[14px] font-bold">
                    <Icon name="film" className="size-4 text-blue" />
                    {p.video}
                  </h2>
                  <div className="mt-3">
                    <PublicIntro ree={ree} video={video} autoPlay={one(query.video) === '1'} />
                    <p className="mt-2 text-[11px] text-muted">{t.video.player.note}</p>
                  </div>
                </section>
              )}
              {ree.sampleQuestions.length > 0 && (
                <section className="mt-7">
                  <h2 className="flex items-center gap-2 text-[14px] font-bold">
                    <Icon name="chat" className="size-4 text-blue" />
                    {p.topics}
                  </h2>
                  <ol className="mt-3 flex flex-col gap-2">
                    {ree.sampleQuestions.slice(0, 3).map((question, index) => (
                      <li key={question} className="flex gap-3 rounded-xl border border-line bg-wash px-4 py-3 text-[13px]">
                        <span className="font-mono text-[11px] text-muted">{String(index + 1).padStart(2, '0')}</span>
                        <p>{question}</p>
                      </li>
                    ))}
                  </ol>
                </section>
              )}
              <AuthorProfile author={{ name: ree.ownerName, avatar: ree.ownerAvatar, role: ree.role, title: ree.ownerTitle, description: ree.ownerDescription, website: ree.ownerWebsite, socialContacts: ree.ownerSocialContacts }} />
              {author && (
                <div className="mt-7">
                  <PublicListSection kind="author" list={author} title={p.author} body={fill(p.authorBody, { name: ree.ownerName })} empty={p.authorEmpty} previousHref={self({ ap: author.page - 1, tab: 'intro' })} nextHref={self({ ap: author.page + 1, tab: 'intro' })} from={from} returnTo={self({ tab: 'intro' })} favoriteIds={favoriteIds} viewerId={viewerId} />
                </div>
              )}
            </div>
          </section>
  );
  const side = (
          <aside className="flex h-fit flex-col gap-5 lg:sticky lg:top-24 lg:col-start-2 lg:row-start-1" aria-label={p.use}>
            <div className="card flex flex-col gap-5 p-5">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-[15px] font-bold">{p.use}</h2>
                <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${ready ? 'border-[#cfe9de] bg-[#f1faf6] text-green' : 'border-line text-muted'}`}>
                  <i className={`size-1.5 rounded-full ${ready ? 'bg-green' : 'bg-[#a3a9bb]'}`} />
                  {ready ? p.ready : p.preparing}
                </span>
              </div>
              <section aria-label={p.perAnswer} className="rounded-xl border border-line p-4">
                <h3 className="text-[12px] text-muted">{p.perAnswer}</h3>
                <p className="mt-1 font-mono text-[26px] font-semibold">
                  {n(ree.price)} <small className="font-sans text-[12px] font-normal text-muted">credits</small>
                </p>
                <dl className="mt-3 flex flex-col gap-1 text-[12px]">
                  <div className="flex justify-between">
                    <dt className="text-muted">{p.base}</dt>
                    <dd className="font-mono">{n(QUERY_BASE_FEE)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted">{p.fee}</dt>
                    <dd className="font-mono">{n(ree.queryFee)}</dd>
                  </div>
                </dl>
                <p className="mt-3 text-[11px] text-muted">{p.onlySuccess}</p>
                {!preview && owner && <p className="mt-1 text-[11px] text-blue">{fill(p.ownerNote, { base: QUERY_BASE_FEE })}</p>}
              </section>
              <p className="flex gap-2 text-[11px] text-muted">
                <Icon name="shield" className="mt-0.5 size-3.5 flex-none text-green" />
                {ready ? p.trustReady : p.trustPreparing}
              </p>
              {preview ? (
                <button type="button" className="btn w-full justify-center opacity-60" disabled>
                  <Icon name="chat" />
                  {t.posts.ask.jump}
                </button>
              ) : (
                <div>
                  <button type="button" className="btn w-full justify-center" disabled={!ready} onClick={goAsk}>
                    <Icon name="chat" />
                    {t.posts.ask.jump}
                  </button>
                  <p className="mt-2 text-center text-[11px] text-muted">{t.posts.ask.jumpHint}</p>
                </div>
              )}
            </div>
            {related && related.items.length > 0 && (
              <section className="card p-5" aria-labelledby="ree-related-heading">
                <h2 id="ree-related-heading" className="flex items-center gap-2 text-[14px] font-bold">
                  <Icon name="compass" className="size-4 text-blue" />
                  {p.related}
                </h2>
                <ul className="mt-3 flex flex-col gap-3">
                  {related.items.slice(0, RELATED_SHOWN).map((item) => (
                    <li key={item.id}>
                      <Link href={`/r/${item.slug}${from !== '/explore' ? `?from=${encodeURIComponent(from)}` : ''}`} className="group flex items-center gap-2.5">
                        <ReeAvatar avatar={item.avatarBlob} color={item.color} size="sm" />
                        <span className="min-w-0">
                          <strong className="block truncate text-[12px] group-hover:text-blue">{item.name}</strong>
                          <span className="text-[10px] text-muted">{fill(q.relatedAnswers, { n: n(item.answers) })}</span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
                <Link href={`/explore?category=${ree.category}`} className="mt-3 inline-flex text-[12px] text-blue hover:underline">
                  {q.relatedMore}
                </Link>
              </section>
            )}
          </aside>
  );

  if (!preview) {
    return (
      <>
        <PublicVisit from={from} />
        <FeedColumns title={ree.name} back={from} rail={side}>
          <div className="px-[18px] pt-4 pb-10">{body}</div>
        </FeedColumns>
      </>
    );
  }

  return (
    <>
      {!preview && <PublicVisit from={from} />}
      {preview ? (
        <Topbar crumbs={[
          { label: t.rees.title, href: '/rees' },
          { label: ree.name, href: `/rees/${ree.id}/settings` },
          { label: t.reeSetup.settings.preview },
        ]} />
      ) : viewerId ? (
        <Topbar crumbs={[{ label: t.discover.explore.title, href: from }, { label: ree.name }]} />
      ) : (
        <nav aria-label={p.breadcrumb} className="mx-auto flex max-w-[1120px] items-center gap-2 px-4 pt-6 text-[12px] sm:px-6">
          <Link href={from} className="flex items-center gap-1.5 text-muted hover:text-blue">
            <Icon name="arrowLeft" className="size-3.5" />
            {p.back}
          </Link>
          <Icon name="chevronRight" className="size-3 text-[#a3a9bb]" />
          <span aria-current="page" className="truncate font-semibold">
            {ree.name}
          </span>
        </nav>
      )}
      <main className={`mx-auto w-full max-w-[1120px] px-4 pb-16 sm:px-6 ${viewerId ? 'pt-6 md:px-8' : 'pt-4'}`}>
        {preview && (
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-wash px-4 py-3 text-[13px]">
            <p role={draftId ? 'status' : undefined}>
              {draft ? t.reeSetup.settings.draftPreviewNote
                : result === 'unavailable' ? t.reeSetup.settings.draftPreviewUnavailable
                : draftId ? t.reeSetup.settings.draftPreviewLoading
                : t.reeSetup.settings.previewNote}
            </p>
            <Link href={`/rees/${ree.id}/settings`} className="btn-secondary btn-sm">
              <Icon name="arrowLeft" />
              {t.reeSetup.settings.backToSettings}
            </Link>
          </div>
        )}
        <div className={draftId && !result ? 'hidden' : 'grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]'}>
          {body}
          {side}

        </div>
      </main>
    </>
  );
}
