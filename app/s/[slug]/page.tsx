import type { Metadata } from 'next';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { appBaseUrl } from '@/lib/http/cookies';
import { reeUrl } from '@/lib/seo';
import { currentUser } from '@/lib/http/session';
import { publicReeBySlug as lookup, type PublicRee } from '@/lib/services/public-rees';
import { reeCitedSources, reeSourceMix } from '@/lib/services/share-landing';
import { introsFor } from '@/lib/services/video';
import { reePostPicks } from '@/lib/services/posts';
import { publicTags } from '@/lib/domain/explore';
import { askOption, SHARE_POST_PICKS, type PostView } from '@/lib/domain/post';
import { REE_ASK_ANCHOR, ReeAsk } from '@/components/posts/ree-ask';
import { serverMessages } from '@/i18n/server';
import { fill, formatNumber } from '@/i18n/format';
import { Icon } from '@/components/ui/icons';
import { ReeAvatar, UserAvatar } from '@/components/ui/ree-avatar';
import { RoleBadge } from '@/components/discover/role-badge';
import { AuthorProfile } from '@/components/discover/author-profile';
import { PublicIntro } from '@/components/video/public-intro';
import { KIND_ICONS } from '@/components/knowledge/kind-icons';
import { ShareFrame } from '@/components/share/share-frame';
import { ShareVisit } from '@/components/share/share-visit';
import { AskJump, TryQuestions } from '@/components/share/share-ask';
import '@/components/share/share.css';

/** Metadata and the page share one lookup per request. */
const publicReeBySlug = cache(lookup);

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };
type Messages = Awaited<ReturnType<typeof serverMessages>>['t'];

/** The six Ree colors tint the page (components/share/share.css); anything else is the default blue. */
const TONES = new Set(['lilac', 'sand', 'sage', 'rose', 'slate']);

/** How many sample questions 可以这样问它 offers. */
const TRY_QUESTIONS = 4;

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

/** A feed answer is already plain text, cut (posts.ts `answerView`); the landing shows no citation markers. */
function excerpt(text: string): string {
  return text.replace(/\s*\[\d+(?:\s*[,，]\s*\d+)*\]/g, '').trim();
}

function askerName(post: PostView, t: Messages): string {
  const author = post.author;
  if (author.kind === 'user') return author.name;
  return author.kind === 'visitor' ? t.posts.card.visitor : author.kind === 'example' ? t.posts.card.example : t.posts.card.someone;
}

/** Up to three cited sources of one answer, as chips. */
function Cites({ post, label }: { post: PostView; label: string }) {
  const cited = [...new Map((post.answers[0]?.citations ?? []).map((entry) => [entry.knowledgeId, entry])).values()].slice(0, 3);
  if (!cited.length) return null;
  return (
    <ul className="share-cites" aria-label={label}>
      {cited.map((entry) => (
        <li key={entry.knowledgeId} className="share-cite" title={entry.title}>
          <Icon name={KIND_ICONS[entry.kind] ?? 'file'} className="size-3 flex-none" />
          <span>{entry.title}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * `/s/[slug]`: the share page -- the link a Ree's owner (or anyone) sends
 * out, laid out as the Ree's own landing page. Its hero (who it is, who
 * made it, 向 {name} 提问, its figures) beside one real exchange from a
 * public post; 可以这样问它, whose questions go into the box; where its
 * answers come from (its sources by kind, and those its public answers
 * cited); more of what people asked; the creator; and the box to close.
 * Only public things: a public Ree's public posts, shown answers and the
 * counts every public page shows -- never a source nobody was shown, a
 * private post or 试问. A section with nothing to show is left out.
 *
 * Each open is a visit and each post published from the box a conversion
 * (lib/services/share.ts); a visitor's box offers 登录后提问 and comes back
 * to `#ask` with the draft kept (ree-ask.tsx).
 */
export default async function SharePage({ params, searchParams }: Props) {
  const [{ slug }, query, user, { t, locale }] = await Promise.all([params, searchParams, currentUser(), serverMessages()]);
  const ree = await publicReeBySlug(slug);
  if (!ree) notFound();
  const s = t.share.page;
  const n = (value: number) => formatNumber(value, locale);
  const [intros, picks, mix, cited] = await Promise.all([
    introsFor([ree.id]),
    reePostPicks(ree.id, SHARE_POST_PICKS, user?.id),
    reeSourceMix(ree.id),
    reeCitedSources(ree.id),
  ]);
  const video = intros.get(ree.id) ?? null;
  const own = user?.id === ree.ownerId;
  const ready = ree.sources > 0;
  const category = t.common.categories[ree.category as keyof typeof t.common.categories] ?? ree.category;
  const tags = publicTags(ree.tags, category);
  const answered = picks.items.filter((item) => item.answers[0]?.text);
  const [proof, ...highlights] = answered;
  const questions = ree.sampleQuestions.map((question) => question.trim()).filter(Boolean).slice(0, TRY_QUESTIONS);
  const hasCreator = Boolean(ree.ownerTitle.trim() || ree.ownerDescription.trim() || ree.ownerWebsite.trim() || ree.ownerSocialContacts.some((contact) => contact.value.trim()));
  const ask = fill(s.ask, { name: ree.name });
  const tone = TONES.has(ree.color) ? `tone-${ree.color}` : '';
  /* The hero's right side: one real exchange, else the introduction video. */
  const side = proof ? 'proof' : video ? 'video' : null;

  return (
    <ShareFrame
      powered={s.powered}
      wide
      action={ready ? <AskJump slug={ree.slug} className="btn btn-sm">{t.posts.ask.jump}</AskJump> : null}
    >
      <ShareVisit slug={ree.slug} />
      <div className={`share-landing ${tone}`}>
        <article className={`share-hero${side ? ' has-side' : ''}`} aria-labelledby="share-name">
          <div className="share-hero-main">
            <p className="text-[12px] text-muted">{fill(s.sharedBy, { name: ree.ownerName })}</p>
            <div className="mt-5 flex items-start gap-4">
              <ReeAvatar avatar={ree.avatarBlob} color={ree.color} size="lg" className="sm:size-[76px]" />
              <div className="min-w-0">
                <h1 id="share-name" className="share-name">{ree.name}</h1>
                <p className="mt-2 flex flex-wrap items-center text-[13px] text-muted">
                  {fill(s.by, { name: ree.ownerName })}
                  <RoleBadge role={ree.role} />
                </p>
              </div>
            </div>
            {ree.description && <p className="share-lede mt-6">{ree.description}</p>}
            <ul className="mt-5 flex flex-wrap gap-2" aria-label={category}>
              <li className="tag">{category}</li>
              {tags.slice(0, 5).map((tag) => (
                <li key={tag} className="tag">{tag}</li>
              ))}
            </ul>
            <div className="mt-7 flex flex-wrap items-center gap-3">
              {ready ? (
                <AskJump slug={ree.slug} className="btn">
                  <Icon name="chat" />
                  {ask}
                </AskJump>
              ) : (
                <p className="text-[12px] text-muted">{s.preparing}</p>
              )}
              <Link href={`/r/${ree.slug}`} className="btn-secondary">
                {s.profile}
              </Link>
            </div>
            <dl className="share-facts" aria-label={fill(s.facts.label, { name: ree.name })}>
              {ree.answers > 0 && (
                <div>
                  <dt>{s.facts.answers}</dt>
                  <dd>{n(ree.answers)}</dd>
                </div>
              )}
              {ree.positiveRate !== null && (
                <div>
                  <dt>{s.facts.helpful}</dt>
                  <dd>{ree.positiveRate}%</dd>
                </div>
              )}
              {ready && (
                <div>
                  <dt>{s.facts.sources}</dt>
                  <dd>{n(ree.sources)}</dd>
                </div>
              )}
              <div>
                <dt>{s.facts.price}</dt>
                <dd>{n(own ? ree.price - ree.queryFee : ree.price)}</dd>
              </div>
            </dl>
          </div>

          {side === 'proof' && proof && (
            <div className="share-hero-side">
              <figure className="share-proof">
                <figcaption className="text-[11px] font-semibold text-[color:var(--tone)]">{s.proof.label}</figcaption>
                <div className="mt-3 flex items-center gap-2 text-[11px] text-muted">
                  <UserAvatar name={askerName(proof, t)} avatar={proof.author.kind === 'user' ? proof.author.avatar : null} className="size-5 text-[8px]" />
                  {fill(s.proof.asked, { name: askerName(proof, t) })}
                </div>
                <p className="share-proof-question mt-1.5">{proof.question}</p>
                <div className="share-proof-answer">
                  <div className="flex items-center gap-2 text-[11px] text-muted">
                    <ReeAvatar avatar={ree.avatarBlob} color={ree.color} size="sm" className="size-5! rounded-[6px]! [&_svg]:size-3!" />
                    {fill(s.proof.answered, { name: ree.name })}
                  </div>
                  <p className="share-excerpt mt-2">{excerpt(proof.answers[0]!.text)}</p>
                  <Cites post={proof} label={s.proof.cited} />
                </div>
                <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted">
                  {proof.helpful > 0 ? (
                    <span className="inline-flex items-center gap-1">
                      <Icon name="thumbUp" className="size-3" />
                      {fill(s.helpful, { n: n(proof.helpful) })}
                    </span>
                  ) : <span />}
                  <Link href={`/p/${proof.id}`} className="text-link">
                    {s.proof.read}
                    <Icon name="chevronRight" className="size-3" />
                  </Link>
                </div>
              </figure>
            </div>
          )}
          {side === 'video' && video && (
            <div className="share-hero-side">
              <PublicIntro ree={ree} video={video} autoPlay={one(query.video) === '1'} />
            </div>
          )}
        </article>

        {video && side !== 'video' && (
          <section className="share-section" aria-labelledby="share-video">
            <div>
              <h2 id="share-video" className="share-section-title">{t.discover.public.video}</h2>
            </div>
            <div className="overflow-hidden rounded-[14px] border border-line bg-white">
              <PublicIntro ree={ree} video={video} autoPlay={one(query.video) === '1'} />
            </div>
          </section>
        )}

        {questions.length > 0 && (
          <section className="share-section" aria-labelledby="share-topics">
            <div>
              <h2 id="share-topics" className="share-section-title">{s.topics}</h2>
              {ready && <p className="share-section-note">{s.topicsHint}</p>}
            </div>
            <TryQuestions slug={ree.slug} questions={questions} live={ready} />
          </section>
        )}

        {ready && <Knowledge ree={ree} mix={mix} cited={cited} t={t} n={n} />}

        {highlights.length > 0 && (
          <section className="share-section" aria-labelledby="share-picks">
            <div>
              <h2 id="share-picks" className="share-section-title">{s.picks}</h2>
              <p className="share-section-note">{fill(s.picksCount, { n: n(picks.total) })}</p>
            </div>
            <div>
              <ul className="share-list">
                {highlights.map((post) => (
                  <li key={post.id} className="share-qa">
                    <div className="min-w-0">
                      <p className="text-[11px] text-muted">{fill(s.proof.asked, { name: askerName(post, t) })}</p>
                      <Link href={`/p/${post.id}`} className="mt-1 block text-[15px] leading-snug font-bold [overflow-wrap:anywhere] hover:text-blue">
                        {post.question}
                      </Link>
                    </div>
                    <div className="min-w-0">
                      <p className="share-excerpt">{excerpt(post.answers[0]!.text)}</p>
                      <Cites post={post} label={s.proof.cited} />
                      {post.helpful > 0 && (
                        <p className="mt-2 inline-flex items-center gap-1 text-[11px] text-muted">
                          <Icon name="thumbUp" className="size-3" />
                          {fill(s.helpful, { n: n(post.helpful) })}
                        </p>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
              <Link href={`/r/${ree.slug}`} className="text-link mt-3">
                {fill(s.allAnswers, { n: n(picks.total) })}
                <Icon name="chevronRight" className="size-3" />
              </Link>
            </div>
          </section>
        )}

        {hasCreator && (
          <div className="mt-14 min-w-0 rounded-[14px] border border-line bg-white px-5 pb-6 sm:px-7 lg:mt-[72px] [&>section]:mt-0! [&>section]:border-t-0! [&>section]:pt-6!">
            <AuthorProfile author={{ name: ree.ownerName, avatar: ree.ownerAvatar, role: ree.role, title: ree.ownerTitle, description: ree.ownerDescription, website: ree.ownerWebsite, socialContacts: ree.ownerSocialContacts }} />
          </div>
        )}

        {ready && (
          <section className="share-closing" aria-labelledby="share-closing">
            <div className="mx-auto max-w-[680px]">
              <div className="flex items-center gap-3">
                <ReeAvatar avatar={ree.avatarBlob} color={ree.color} size="md" />
                <h2 id="share-closing" className="share-section-title min-w-0 [overflow-wrap:anywhere]">{ask}</h2>
              </div>
              <p className="share-section-note">{[ree.takesPosts ? s.closing.body : s.closing.privateOnly, s.closing.cost].join(locale === 'zh' ? '' : ' ')}</p>
              <ReeAsk
                ree={{ id: ree.id, slug: ree.slug, name: ree.name }}
                option={askOption(ree, own)}
                takesPosts={ree.takesPosts}
                signedIn={Boolean(user)}
                loginHref={`/login?returnTo=${encodeURIComponent(`/s/${ree.slug}#${REE_ASK_ANCHOR}`)}`}
                share={user && !own ? ree.slug : null}
              />
            </div>
          </section>
        )}
      </div>
    </ShareFrame>
  );
}

/** 它的回答从哪里来: its sources by kind, and the ones its public answers cited. */
function Knowledge({ ree, mix, cited, t, n }: { ree: PublicRee; mix: Awaited<ReturnType<typeof reeSourceMix>>; cited: Awaited<ReturnType<typeof reeCitedSources>>; t: Messages; n: (value: number) => string }) {
  const k = t.share.page.knows;
  const total = mix.reduce((sum, entry) => sum + entry.count, 0);
  if (!total && !cited.length) return null;
  return (
    <section className="share-section" aria-labelledby="share-knows">
      <div>
        <h2 id="share-knows" className="share-section-title">{k.heading}</h2>
        <p className="share-section-note">{fill(k.lede, { name: ree.name, n: n(ree.sources) })}</p>
      </div>
      <div className="flex min-w-0 flex-col gap-5">
        {total > 0 && (
          <div className="rounded-[14px] border border-line bg-white p-5">
            <h3 className="text-[12px] font-semibold">{k.mix}</h3>
            <div className="share-mix-bar mt-3" aria-hidden="true">
              {mix.map((entry) => (
                <span key={entry.kind} style={{ flexGrow: entry.count, flexBasis: 0 }} />
              ))}
            </div>
            <ul className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-[13px]">
              {mix.map((entry) => (
                <li key={entry.kind} className="inline-flex items-center gap-2">
                  <Icon name={KIND_ICONS[entry.kind]} className="size-3.5 text-[color:var(--tone)]" />
                  {t.common.kinds[entry.kind]}
                  <strong className="font-mono text-[13px]">{n(entry.count)}</strong>
                </li>
              ))}
            </ul>
          </div>
        )}
        {cited.length > 0 && (
          <div>
            <h3 className="mb-2 text-[12px] font-semibold">{k.cited}</h3>
            <ul className="share-list">
              {cited.map((entry) => (
                <li key={entry.knowledgeId} className="flex items-center gap-3 px-4 py-3">
                  <span className="grid size-8 flex-none place-items-center rounded-lg bg-[var(--tone-tint)] text-[color:var(--tone)]">
                    <Icon name={KIND_ICONS[entry.kind]} className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <strong className="block truncate text-[13px] font-semibold" title={entry.title}>{entry.title}</strong>
                    <span className="text-[11px] text-muted">
                      {t.common.kinds[entry.kind]} · {entry.answers === 1 ? k.citedOne : fill(k.citedCount, { n: n(entry.answers) })}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
