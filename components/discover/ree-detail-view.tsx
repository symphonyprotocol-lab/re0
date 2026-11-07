'use client';

import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { QUERY_BASE_FEE } from '@/lib/constants';
import { publicTags } from '@/lib/domain/explore';
import { REE_COMMENTS_ANCHOR, type ReeCommentPage } from '@/lib/domain/ree-comment';
import type { PublicList, PublicRee } from '@/lib/services/public-rees';
import { fill, formatNumber } from '@/i18n/format';
import { Topbar } from '@/components/shell/topbar';
import { Icon } from '@/components/ui/icons';
import { ReeIdentityCover } from '@/components/rees/ree-identity-cover';
import { RoleBadge } from '@/components/discover/role-badge';
import { AuthorProfile } from '@/components/discover/author-profile';
import { JoinButton } from '@/components/discover/join-button';
import { PublicListSection } from '@/components/discover/public-list';
import { PublicVisit } from '@/components/discover/public-visit';
import { ReeComments } from '@/components/discover/ree-comments';
import { ReeFavoriteButton } from '@/components/rees/ree-favorite-button';
import { PublicIntro } from '@/components/video/public-intro';
import { useI18n } from '@/i18n/client';
import { useReePreviewDraft } from '@/lib/client/ree-preview';
import type { IntroProps } from '@/lib/domain/video';

type Search = Record<string, string | string[] | undefined>;

function one(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

export function ReeDetailView({
  savedRee, query, viewerId, preview, draftId, from, related, author, conversations, video, comments, favoriteIds, renderedAt,
}: {
  savedRee: PublicRee;
  query: Search;
  viewerId?: string;
  preview: boolean;
  draftId?: string;
  from: string;
  related: PublicList | null;
  author: PublicList | null;
  conversations: { id: string; title: string; members: number }[];
  video: IntroProps | null;
  comments: ReeCommentPage | null;
  favoriteIds?: string[];
  renderedAt: number;
}) {
  const { t, locale } = useI18n();
  const p = t.discover.public;
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
    const merged = { rp: related?.page, ap: author?.page, ...changes };
    if (merged.rp && merged.rp !== 1) next.set('rp', String(merged.rp));
    if (merged.ap && merged.ap !== 1) next.set('ap', String(merged.ap));
    return next.size ? `/r/${ree.slug}?${next}` : `/r/${ree.slug}`;
  };
  const ready = ree.sources > 0;
  const category = t.common.categories[ree.category as keyof typeof t.common.categories] ?? ree.category;

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
          <section className="card min-w-0 p-5 sm:p-7" aria-label={ree.name}>
            <header>
              <ReeIdentityCover src={coverSrc} avatar={ree.avatarBlob} color={ree.color} video={video} />
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-[1_1_190px]">
                  <span className="font-mono text-[10px] tracking-[0.18em] text-muted">{p.eyebrow}</span>
                  <h1 className="mt-1 text-[24px] leading-tight font-extrabold tracking-tight break-words sm:text-[28px]">{ree.name}</h1>
                </div>
                {!preview && ree.ownerId !== viewerId && (
                  <ReeFavoriteButton ree={ree} favorite={favoriteIds?.includes(ree.id)} returnTo={self({})} labeled />
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
                  <a href="#author-profile" className="hover:text-blue hover:underline">{fill(p.by, { name: ree.ownerName })}</a>
                  <RoleBadge role={ree.role} />
                </span>
                <span className="flex items-center gap-1">
                  <Icon name="globe" className="size-3.5" />
                  {p.publicRee}
                </span>
              </div>
            </header>
            <AuthorProfile author={{ name: ree.ownerName, avatar: ree.ownerAvatar, role: ree.role, title: ree.ownerTitle, description: ree.ownerDescription, website: ree.ownerWebsite, socialContacts: ree.ownerSocialContacts }} />
            {video && (
              <section className="mt-7 border-t border-line pt-6">
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
          </section>

          <aside className="card flex h-fit flex-col gap-5 p-5 lg:sticky lg:top-24 lg:col-start-2 lg:row-span-2 lg:row-start-1" aria-label={p.use}>
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-[15px] font-bold">{p.use}</h2>
              <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${ready ? 'border-[#cfe9de] bg-[#f1faf6] text-green' : 'border-line text-muted'}`}>
                <i className={`size-1.5 rounded-full ${ready ? 'bg-green' : 'bg-[#a3a9bb]'}`} />
                {ready ? p.ready : p.preparing}
              </span>
            </div>
            <dl className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-xl bg-wash px-2 py-3">
                <dt className="text-[10px] text-muted">{p.answers}</dt>
                <dd className="mt-1 font-mono text-[18px] font-semibold">{n(ree.answers)}</dd>
              </div>
              <div className="rounded-xl bg-wash px-2 py-3">
                <dt className="text-[10px] text-muted">{p.sources}</dt>
                <dd className="mt-1 font-mono text-[18px] font-semibold">{n(ree.sources)}</dd>
              </div>
              <div className="rounded-xl bg-wash px-2 py-3">
                <dt className="text-[10px] text-muted">{p.rating}</dt>
                <dd className="mt-1 font-mono text-[18px] font-semibold">{ree.positiveRate === null ? <small className="font-sans text-[11px] font-normal text-muted">{p.noRating}</small> : `${ree.positiveRate}%`}</dd>
              </div>
            </dl>
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
              {!preview && viewerId === ree.ownerId && <p className="mt-1 text-[11px] text-blue">{fill(p.ownerNote, { base: QUERY_BASE_FEE })}</p>}
            </section>
            <p className="flex gap-2 text-[11px] text-muted">
              <Icon name="shield" className="mt-0.5 size-3.5 flex-none text-green" />
              {ready ? p.trustReady : p.trustPreparing}
            </p>
            {preview ? (
              <button type="button" className="btn w-full justify-center opacity-60" disabled>
                <Icon name="plus" />
                {p.join}
              </button>
            ) : (
              <div>
                <JoinButton
                  ree={{ id: ree.id, name: ree.name, description: ree.description, avatarBlob: ree.avatarBlob, color: ree.color, price: viewerId === ree.ownerId ? QUERY_BASE_FEE : ree.price }}
                  signedIn={Boolean(viewerId)}
                  conversations={conversations}
                  returnTo={`${self({})}${self({}).includes('?') ? '&' : '?'}join=1`}
                  openOnLoad={one(query.join) === '1'}
                />
                <p className="mt-2 text-center text-[11px] text-muted">{viewerId ? p.joinHint : p.signIn}</p>
              </div>
            )}
          </aside>
          {comments && (
            <ReeComments
              key={ree.id}
              reeId={ree.id}
              initial={comments}
              signedIn={Boolean(viewerId)}
              loginHref={`/login?returnTo=${encodeURIComponent(`/r/${ree.slug}#${REE_COMMENTS_ANCHOR}`)}`}
              renderedAt={renderedAt}
            />
          )}
        </div>

        {related && author && (
          <div className="mt-8 flex flex-col gap-5">
            <PublicListSection kind="related" list={related} title={p.related} body={p.relatedBody} empty={p.relatedEmpty} previousHref={self({ rp: related.page - 1 })} nextHref={self({ rp: related.page + 1 })} from={from} returnTo={self({})} favoriteIds={favoriteIds} viewerId={viewerId} />
            <PublicListSection kind="author" list={author} title={p.author} body={fill(p.authorBody, { name: ree.ownerName })} empty={p.authorEmpty} previousHref={self({ ap: author.page - 1 })} nextHref={self({ ap: author.page + 1 })} from={from} returnTo={self({})} favoriteIds={favoriteIds} viewerId={viewerId} />
          </div>
        )}
      </main>
    </>
  );
}
