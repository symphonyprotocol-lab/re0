import type { Metadata } from 'next';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { appBaseUrl } from '@/lib/http/cookies';
import { reeUrl } from '@/lib/seo';
import { currentUser } from '@/lib/http/session';
import { publicReeBySlug as lookup } from '@/lib/services/public-rees';
import { introsFor } from '@/lib/services/video';
import { reePostPicks } from '@/lib/services/posts';
import { askOption, SHARE_POST_PICKS } from '@/lib/domain/post';
import { ReePostList } from '@/components/posts/ree-posts';
import { REE_ASK_ANCHOR, ReeAsk } from '@/components/posts/ree-ask';
import { serverMessages } from '@/i18n/server';
import { fill, formatNumber } from '@/i18n/format';
import { Icon } from '@/components/ui/icons';
import { ReeAvatar } from '@/components/ui/ree-avatar';
import { RoleBadge } from '@/components/discover/role-badge';
import { ReeCover } from '@/components/discover/ree-card';
import { PublicIntro } from '@/components/video/public-intro';
import { ShareFrame } from '@/components/share/share-frame';
import { ShareVisit } from '@/components/share/share-visit';

/** Metadata and the page share one lookup per request. */
const publicReeBySlug = cache(lookup);

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

function one(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

/** Not indexed: the public page `/r/[slug]` is the canonical one, in the Ree's content language or else this one (lib/seo.ts `reePage`). The link preview is ./opengraph-image.tsx. */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const [ree, { locale }] = await Promise.all([params.then(({ slug }) => publicReeBySlug(slug)), serverMessages()]);
  if (!ree) return { title: { absolute: 'RE0' }, robots: { index: false } };
  const base = appBaseUrl();
  return {
    title: ree.name,
    description: ree.description || undefined,
    alternates: { canonical: reeUrl(ree, locale) },
    robots: { index: false, follow: true },
    openGraph: { type: 'website', title: ree.name, description: ree.description || undefined, url: `${base}/s/${ree.slug}`, siteName: 'RE0' },
    twitter: { card: 'summary_large_image', title: ree.name, description: ree.description || undefined },
  };
}

/**
 * `/s/[slug]`: the share page -- one Ree on its own, for the link its owner
 * (or anyone) sends out. Its introduction, who made it, what people asked
 * it, and 向 {name} 提问; no related lists and no workspace around it. Only
 * a public Ree has one. "大家问过的" is post cards (稿 2, section 5): the
 * public posts it answered -- pinned, then most helpful -- each with its
 * answer, in place of the sample questions; the whole list is on the Ree
 * page. The box names this Ree and posts publicly or asks it privately; a
 * visitor sees the same box with 登录后提问 and comes back to it with the
 * draft kept (ree-ask.tsx). Each open is a visit and each post published
 * here a conversion (lib/services/share.ts). Anonymous chat is gone.
 */
export default async function SharePage({ params, searchParams }: Props) {
  const [{ slug }, query, user, { t, locale }] = await Promise.all([params, searchParams, currentUser(), serverMessages()]);
  const ree = await publicReeBySlug(slug);
  if (!ree) notFound();
  const s = t.share.page;
  const n = (value: number) => formatNumber(value, locale);
  const [intros, picks] = await Promise.all([introsFor([ree.id]), reePostPicks(ree.id, SHARE_POST_PICKS, user?.id)]);
  const video = intros.get(ree.id) ?? null;
  const own = user?.id === ree.ownerId;
  const category = t.common.categories[ree.category as keyof typeof t.common.categories] ?? ree.category;

  return (
    <ShareFrame powered={s.powered}>
      <ShareVisit slug={ree.slug} />
      <article className="card overflow-hidden shadow-[0_18px_48px_#0911350d]" aria-label={ree.name}>
        <div className="border-b border-line">
          {video ? <PublicIntro ree={ree} video={video} autoPlay={one(query.video) === '1'} /> : <ReeCover ree={ree} />}
        </div>
        <div className="p-5 sm:p-8">
          <header className="flex items-center gap-4">
            <ReeAvatar avatar={ree.avatarBlob} color={ree.color} size="lg" />
            <div className="min-w-0">
              <span className="font-mono text-[10px] tracking-[0.18em] text-muted">{s.eyebrow}</span>
              <h1 className="mt-1 text-[24px] leading-tight font-extrabold tracking-tight break-words sm:text-[30px]">{ree.name}</h1>
              <p className="mt-1 flex items-center text-[12px] text-muted">
                {fill(s.sharedBy, { name: ree.ownerName })}
                <RoleBadge role={ree.role} />
              </p>
            </div>
          </header>
          {ree.description && <p className="mt-5 text-[14px] leading-relaxed text-[#3b4361]">{ree.description}</p>}
          <ul className="mt-4 flex flex-wrap gap-2 text-[11px]" aria-label={ree.name}>
            <li className="tag">{category}</li>
            <li className="tag">
              <Icon name="layers" className="size-3" />
              {fill(s.sources, { n: n(ree.sources) })}
            </li>
            {ree.answers > 0 && (
              <li className="tag">
                <Icon name="chat" className="size-3" />
                {fill(s.answers, { n: n(ree.answers) })}
              </li>
            )}
            {ree.positiveRate !== null && (
              <li className="tag">
                <Icon name="thumbUp" className="size-3" />
                {fill(t.discover.public.positive, { n: ree.positiveRate })}
              </li>
            )}
          </ul>

          {picks.items.length > 0 ? (
            <section className="mt-7">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="flex items-center gap-2 text-[14px] font-bold">
                  <Icon name="chat" className="size-4 text-blue" />
                  {s.picks}
                </h2>
                <span className="text-[11px] text-muted">{fill(s.picksCount, { n: n(picks.total) })}</span>
              </div>
              <ReePostList reeId={ree.id} initial={{ items: picks.items, total: picks.total, next: null }} signedIn={Boolean(user)} renderedAt={Date.now()} />
            </section>
          ) : (
            ree.sampleQuestions.length > 0 && (
              <section className="mt-7">
                <h2 className="flex items-center gap-2 text-[14px] font-bold">
                  <Icon name="sparkle" className="size-4 text-blue" />
                  {s.topics}
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
            )
          )}

          {ree.sources > 0 ? (
            <ReeAsk
              ree={{ id: ree.id, slug: ree.slug, name: ree.name }}
              option={askOption(ree, own)}
              takesPosts={ree.takesPosts}
              signedIn={Boolean(user)}
              loginHref={`/login?returnTo=${encodeURIComponent(`/s/${ree.slug}#${REE_ASK_ANCHOR}`)}`}
              share={user && !own ? ree.slug : null}
            />
          ) : (
            <p className="mt-7 rounded-xl border border-line bg-wash px-4 py-3 text-[12px] text-muted">{t.discover.public.anonymous.noSources}</p>
          )}

          <div className="mt-5 flex justify-center">
            <Link href={`/r/${ree.slug}`} className="text-link">
              {picks.total > 0 ? fill(s.allAnswers, { n: n(picks.total) }) : s.profile}
              <Icon name="chevronRight" className="size-3" />
            </Link>
          </div>
        </div>
      </article>
    </ShareFrame>
  );
}
