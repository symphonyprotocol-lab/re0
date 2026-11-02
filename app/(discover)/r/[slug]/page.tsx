import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { QUERY_BASE_FEE } from '@/lib/constants';
import { exploreReturnPath } from '@/lib/domain/explore';
import { appBaseUrl } from '@/lib/http/cookies';
import { currentUser } from '@/lib/http/session';
import { joinableConversations } from '@/lib/services/conversations';
import { authorOthers, publicReeBySlug as lookup, relatedFor } from '@/lib/services/public-rees';
import { serverMessages } from '@/i18n/server';
import { fill, formatNumber } from '@/i18n/format';
import { Topbar } from '@/components/shell/topbar';
import { Icon } from '@/components/ui/icons';
import { ReeAvatar } from '@/components/ui/ree-avatar';
import { RoleBadge } from '@/components/discover/role-badge';
import { JoinButton } from '@/components/discover/join-button';
import { PublicListSection } from '@/components/discover/public-list';
import { ReeCover } from '@/components/discover/ree-card';

/** Metadata and the page share one lookup per request. */
const publicReeBySlug = cache(lookup);

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

function one(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const ree = await publicReeBySlug((await params).slug);
  if (!ree) return { title: 'RE0', robots: { index: false } };
  const url = `${appBaseUrl()}/r/${ree.slug}`;
  return {
    title: ree.name,
    description: ree.description || undefined,
    alternates: { canonical: url },
    robots: { index: true, follow: true },
    openGraph: { type: 'profile', title: ree.name, description: ree.description || undefined, url, siteName: 'RE0' },
    twitter: { card: 'summary_large_image', title: ree.name, description: ree.description || undefined },
  };
}

/**
 * `/r/[slug]` (rebuild-proposal.md 2.4, prototype public-dot.js): a public
 * Ree on show -- no input, no answers here; asking happens in a
 * conversation, and 「加入对话」 is the one action. Knowledge appears only as
 * a count. Private, taken-down and deleted Rees are not found. Indexable.
 */
export default async function PublicReePage({ params, searchParams }: Props) {
  const [{ slug }, query, user, { t, locale }] = await Promise.all([params, searchParams, currentUser(), serverMessages()]);
  const ree = await publicReeBySlug(slug);
  if (!ree) notFound();
  const p = t.discover.public;
  const n = (value: number) => formatNumber(value, locale);
  const from = exploreReturnPath(one(query.from));
  const relatedPage = Number(one(query.rp)) || 1;
  const authorPage = Number(one(query.ap)) || 1;
  const [related, author, conversations] = await Promise.all([relatedFor(ree, relatedPage), authorOthers(ree, authorPage), user ? joinableConversations(user.id, ree.id) : Promise.resolve([])]);
  const self = (changes: Record<string, string | number | null>) => {
    const next = new URLSearchParams();
    if (from !== '/explore') next.set('from', from);
    const merged = { rp: related.page, ap: author.page, ...changes };
    if (merged.rp && merged.rp !== 1) next.set('rp', String(merged.rp));
    if (merged.ap && merged.ap !== 1) next.set('ap', String(merged.ap));
    return next.size ? `/r/${ree.slug}?${next}` : `/r/${ree.slug}`;
  };
  const ready = ree.sources > 0;
  const category = t.common.categories[ree.category as keyof typeof t.common.categories] ?? ree.category;

  return (
    <>
      {user ? (
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
      <main className={`mx-auto w-full max-w-[1120px] px-4 pb-16 sm:px-6 ${user ? 'pt-6 md:px-8' : 'pt-4'}`}>
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
          <section className="card min-w-0 p-5 sm:p-7" aria-label={ree.name}>
            <header>
              <div className="flex items-center gap-4">
                <ReeAvatar avatar={ree.avatarBlob} color={ree.color} size="lg" />
                <div className="min-w-0">
                  <span className="font-mono text-[10px] tracking-[0.18em] text-muted">{p.eyebrow}</span>
                  <h1 className="mt-1 text-[24px] leading-tight font-extrabold tracking-tight break-words sm:text-[28px]">{ree.name}</h1>
                </div>
              </div>
              <p className="mt-4 text-[14px] leading-relaxed text-[#3b4361]">{ree.description}</p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Link href={`/explore?category=${ree.category}`} className="tag hover:border-blue hover:text-blue">
                  {category}
                </Link>
                {ree.tags.map((tag) => (
                  <Link key={tag} href={`/explore?q=${encodeURIComponent(tag)}`} className="tag hover:border-blue hover:text-blue">
                    {tag}
                  </Link>
                ))}
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted">
                <span className="flex items-center">
                  {fill(p.by, { name: ree.ownerName })}
                  <RoleBadge role={ree.role} />
                </span>
                <span className="flex items-center gap-1">
                  <Icon name="globe" className="size-3.5" />
                  {p.publicRee}
                </span>
              </div>
            </header>
            <section className="mt-7">
              <h2 className="flex items-center gap-2 text-[14px] font-bold">
                <Icon name="film" className="size-4 text-blue" />
                {p.video}
              </h2>
              <div className="mt-3 overflow-hidden rounded-xl border border-line">
                <ReeCover ree={ree} />
              </div>
              <p className="mt-2 text-[11px] text-muted">{p.videoSoon}</p>
            </section>
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

          <aside className="card flex h-fit flex-col gap-5 p-5 lg:sticky lg:top-24" aria-label={p.use}>
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
              {user?.id === ree.ownerId && <p className="mt-1 text-[11px] text-blue">{fill(p.ownerNote, { base: QUERY_BASE_FEE })}</p>}
            </section>
            <p className="flex gap-2 text-[11px] text-muted">
              <Icon name="shield" className="mt-0.5 size-3.5 flex-none text-green" />
              {ready ? p.trustReady : p.trustPreparing}
            </p>
            <div>
              <JoinButton
                ree={{ id: ree.id, name: ree.name, description: ree.description, avatarBlob: ree.avatarBlob, color: ree.color, price: user?.id === ree.ownerId ? QUERY_BASE_FEE : ree.price }}
                signedIn={Boolean(user)}
                conversations={conversations}
                returnTo={`${self({})}${self({}).includes('?') ? '&' : '?'}join=1`}
                openOnLoad={one(query.join) === '1'}
              />
              <p className="mt-2 text-center text-[11px] text-muted">{user ? p.joinHint : p.signIn}</p>
            </div>
          </aside>
        </div>

        <div className="mt-8 flex flex-col gap-5">
          <PublicListSection kind="related" list={related} title={p.related} body={p.relatedBody} empty={p.relatedEmpty} previousHref={self({ rp: related.page - 1 })} nextHref={self({ rp: related.page + 1 })} from={from} />
          <PublicListSection kind="author" list={author} title={p.author} body={fill(p.authorBody, { name: ree.ownerName })} empty={p.authorEmpty} previousHref={self({ ap: author.page - 1 })} nextHref={self({ ap: author.page + 1 })} from={from} />
        </div>
      </main>
    </>
  );
}
