import type { Metadata } from 'next';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { QUERY_BASE_FEE } from '@/lib/constants';
import { appBaseUrl } from '@/lib/http/cookies';
import { currentUser } from '@/lib/http/session';
import { joinableConversations } from '@/lib/services/conversations';
import { publicReeBySlug as lookup } from '@/lib/services/public-rees';
import { introsFor } from '@/lib/services/video';
import { serverMessages } from '@/i18n/server';
import { fill, formatNumber } from '@/i18n/format';
import { Icon } from '@/components/ui/icons';
import { ReeAvatar } from '@/components/ui/ree-avatar';
import { RoleBadge } from '@/components/discover/role-badge';
import { JoinButton } from '@/components/discover/join-button';
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

/** Not indexed: the public page `/r/[slug]` is the canonical one. The link preview is ./opengraph-image.tsx. */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const ree = await publicReeBySlug((await params).slug);
  if (!ree) return { title: { absolute: 'RE0' }, robots: { index: false } };
  const base = appBaseUrl();
  return {
    title: ree.name,
    description: ree.description || undefined,
    alternates: { canonical: `${base}/r/${ree.slug}` },
    robots: { index: false, follow: true },
    openGraph: { type: 'website', title: ree.name, description: ree.description || undefined, url: `${base}/s/${ree.slug}`, siteName: 'RE0' },
    twitter: { card: 'summary_large_image', title: ree.name, description: ree.description || undefined },
  };
}

/**
 * `/s/[slug]`: the share page -- one Ree on its own, for the link its owner
 * (or anyone) sends out. Its introduction, who made it, what to ask, and
 * 「开始对话」; no related lists and no workspace around it. Open to
 * visitors; a visitor signs in and comes back with the dialog open. Only a
 * public Ree has one. Each open is a visit and each conversation started
 * here a conversion (lib/services/share.ts).
 */
export default async function SharePage({ params, searchParams }: Props) {
  const [{ slug }, query, user, { t, locale }] = await Promise.all([params, searchParams, currentUser(), serverMessages()]);
  const ree = await publicReeBySlug(slug);
  if (!ree) notFound();
  const s = t.share.page;
  const n = (value: number) => formatNumber(value, locale);
  const [conversations, intros] = await Promise.all([user ? joinableConversations(user.id, ree.id) : Promise.resolve([]), introsFor([ree.id])]);
  const video = intros.get(ree.id) ?? null;
  const own = user?.id === ree.ownerId;
  const price = own ? QUERY_BASE_FEE : ree.price;
  const category = t.common.categories[ree.category as keyof typeof t.common.categories] ?? ree.category;

  return (
    <ShareFrame signedIn={Boolean(user)} home={`RE0 ${t.site.nav.home}`} action={user ? { href: '/rees', label: t.site.nav.open } : { href: `/login?returnTo=${encodeURIComponent(`/s/${ree.slug}`)}`, label: t.site.nav.signIn }}>
      <ShareVisit slug={ree.slug} />
      <main className="mx-auto w-full max-w-[760px] flex-1 px-4 pb-14 sm:px-6">
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

            {ree.sampleQuestions.length > 0 && (
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
            )}

            <section className="mt-7 rounded-[12px] border border-[#d6e6fb] bg-soft p-4 sm:p-5" aria-label={s.start}>
              <p className="flex gap-2 text-[12px] leading-relaxed text-[#3b4361]">
                <Icon name="shield" className="mt-0.5 size-3.5 flex-none text-green" />
                {s.startHint}
              </p>
              <div className="mt-4">
                <JoinButton
                  ree={{ id: ree.id, name: ree.name, description: ree.description, avatarBlob: ree.avatarBlob, color: ree.color, price }}
                  signedIn={Boolean(user)}
                  conversations={conversations}
                  returnTo={`/s/${ree.slug}?join=1`}
                  openOnLoad={one(query.join) === '1'}
                  label={s.start}
                  share={own ? undefined : ree.slug}
                />
              </div>
              <p className="mt-2 text-center text-[11px] text-muted">{user ? fill(s.perAnswer, { n: n(price) }) : s.signIn}</p>
            </section>

            <div className="mt-5 flex justify-center">
              <Link href={`/r/${ree.slug}`} className="text-link">
                {s.profile}
                <Icon name="chevronRight" className="size-3" />
              </Link>
            </div>
          </div>
        </article>

        <footer className="mt-8 flex flex-col items-center gap-3 text-center text-[12px] text-muted">
          <p>{s.footer}</p>
          <Link href={user ? '/rees/new' : `/login?returnTo=${encodeURIComponent('/rees/new')}`} className="btn-secondary btn-sm">
            <Icon name="plus" />
            {s.create}
          </Link>
        </footer>
      </main>
    </ShareFrame>
  );
}
