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
import { askOption, REE_ASK_ANCHOR, SHARE_POST_PICKS, type PostView } from '@/lib/domain/post';
import { ReeAsk } from '@/components/posts/ree-ask';
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
import { AskAbout, AskJump, TryQuestions } from '@/components/share/share-ask';
import type { ProductSheet } from '@/lib/domain/share-style';

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
    <div className="share-cites-wrap">
      <p className="share-note">{label}</p>
      <ul className="share-cites" aria-label={label}>
        {cited.map((entry) => (
          <li key={entry.knowledgeId} className="share-cite" title={entry.title}>
            <Icon name={KIND_ICONS[entry.kind] ?? 'file'} className="size-3.5 flex-none" />
            <span>{entry.title}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * `/s/[slug]`: the share page -- the link a Ree's owner (or anyone) sends
 * out, laid out as the Ree's own landing page (design A, 2026-11-25: flat
 * grounds, the real exchange leading). The first screen: who it is, who
 * made it, 向 {name} 提问 and its figures, its price first, beside one real
 * exchange from a public post (else its introduction video). Then the box
 * itself with 可以这样问它 beside it, whose questions go into it; more of
 * what people asked; the video when the exchange took the hero; where its
 * answers come from; and a dark foot with the last ask and the creator.
 * Only public things: a public Ree's public posts, shown answers and the
 * counts every public page shows -- never a source nobody was shown, a
 * private post or 试问. A section with nothing to show is left out.
 *
 * The owner may pick the product style instead (lib/domain/share-style.ts):
 * the product's photo -- the Ree's cover -- leads beside its name, what it
 * is and who makes it; then its features and specifications, as the owner
 * typed them; then the same box, picks, video and sources. Without a cover
 * the hero keeps the real exchange, else the video.
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
  const product = ree.shareStyle === 'product' ? ree.productSheet : null;
  const photo = product && ree.coverBlob ? `/media/${ree.coverBlob}` : null;
  /* The hero's right side: the product photo, else one real exchange, else the introduction video. */
  const side = photo ? 'photo' : proof ? 'proof' : video ? 'video' : null;
  /* The exchange the hero did not take leads the picks. */
  const listed = side === 'proof' ? highlights : answered;
  const title = product?.product || ree.name;

  const foot =
    ready || hasCreator ? (
      <div className={`share-foot-row${ready && hasCreator ? ' has-two' : ''}`}>
        {ready && (
          <div className="min-w-0">
            <p className="share-foot-title [overflow-wrap:anywhere]">{ask}</p>
            <AskJump slug={ree.slug} className="share-btn share-btn-light mt-8">
              <Icon name="chat" />
              {t.posts.ask.jump}
            </AskJump>
          </div>
        )}
        {hasCreator && (
          <div className="share-creator min-w-0">
            <AuthorProfile author={{ name: ree.ownerName, avatar: ree.ownerAvatar, role: ree.role, title: ree.ownerTitle, description: ree.ownerDescription, website: ree.ownerWebsite, socialContacts: ree.ownerSocialContacts }} />
          </div>
        )}
      </div>
    ) : null;

  return (
    <ShareFrame
      powered={s.powered}
      wide
      footer={foot}
      action={
        ready ? (
          <AskJump slug={ree.slug} className="share-btn share-btn-sm">
            <Icon name="chat" />
            {t.posts.ask.jump}
          </AskJump>
        ) : null
      }
    >
      <ShareVisit slug={ree.slug} />
      <div className={`share-landing ${tone}`}>
        <article className={`share-hero${side ? ' has-side' : ''}`} aria-labelledby="share-name">
          <div className="share-wrap share-hero-grid">
            <div className="share-hero-main">
              <p className="share-notice">
                <UserAvatar name={ree.ownerName} avatar={ree.ownerAvatar} className="size-6 rounded-[7px] text-[9px]" />
                <span className="min-w-0 [overflow-wrap:anywhere]">{fill(s.sharedBy, { name: ree.ownerName })}</span>
              </p>
              {product ? (
                product.line && <p className="share-kicker">{product.line}</p>
              ) : (
                <ReeAvatar avatar={ree.avatarBlob} color={ree.color} size="lg" className="share-avatar" />
              )}
              <h1 id="share-name" className={`share-name${product ? ' is-product' : ''}`}>{title}</h1>
              <p className="share-byline">
                {title !== ree.name && (
                  <span className="share-byline-ree">
                    <ReeAvatar avatar={ree.avatarBlob} color={ree.color} size="sm" className="size-6! rounded-[7px]! [&_svg]:size-3.5!" />
                    <span>{ree.name}</span>
                    <span aria-hidden="true">·</span>
                  </span>
                )}
                {fill(s.by, { name: ree.ownerName })}
                <RoleBadge role={ree.role} />
              </p>
              {ree.description && <p className="share-lede">{ree.description}</p>}
              {product?.maker && (
                <p className="share-maker">
                  {fill(s.product.madeBy, { maker: product.maker })}
                </p>
              )}
              <ul className="share-tags" aria-label={category}>
                <li>{category}</li>
                {tags.slice(0, 5).map((tag) => (
                  <li key={tag}>{tag}</li>
                ))}
              </ul>
              <div className="share-actions">
                {ready ? (
                  <AskJump slug={ree.slug} className="share-btn">
                    <Icon name="chat" />
                    {ask}
                  </AskJump>
                ) : (
                  <p className="share-preparing">{s.preparing}</p>
                )}
                {product?.link ? (
                  <a href={product.link} className="share-link" target="_blank" rel="noopener noreferrer nofollow">
                    {s.product.site}
                    <Icon name="external" />
                  </a>
                ) : (
                  <Link href={`/r/${ree.slug}`} className="share-link">
                    {s.profile}
                    <Icon name="arrow" />
                  </Link>
                )}
              </div>
              <dl className="share-facts" aria-label={fill(s.facts.label, { name: ree.name })}>
                <div className="is-price">
                  <dt>{s.facts.price}</dt>
                  <dd>{n(own ? ree.price - ree.queryFee : ree.price)}</dd>
                </div>
                {ready && (
                  <div>
                    <dt>{s.facts.sources}</dt>
                    <dd>{n(ree.sources)}</dd>
                  </div>
                )}
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
              </dl>
            </div>

            {side === 'photo' && photo && (
              <figure className="share-photo">
                {/* eslint-disable-next-line @next/next/no-img-element -- the cover is served by /media with its own checks, like every Ree cover */}
                <img src={photo} alt={fill(s.product.photo, { name: title })} />
              </figure>
            )}
            {side === 'proof' && proof && (
              <figure className="share-proof">
                <figcaption className="share-proof-label">{s.proof.label}</figcaption>
                <p className="share-who">
                  <UserAvatar name={askerName(proof, t)} avatar={proof.author.kind === 'user' ? proof.author.avatar : null} className="size-7 text-[10px]" />
                  {fill(s.proof.asked, { name: askerName(proof, t) })}
                </p>
                <p className="share-proof-question">{proof.question}</p>
                <p className="share-who">
                  <ReeAvatar avatar={ree.avatarBlob} color={ree.color} size="sm" className="size-7! rounded-[8px]! [&_svg]:size-4!" />
                  {fill(s.proof.answered, { name: ree.name })}
                </p>
                <p className="share-excerpt share-proof-answer">{excerpt(proof.answers[0]!.text)}</p>
                <Cites post={proof} label={s.proof.cited} />
                <div className="share-proof-foot">
                  {proof.helpful > 0 ? (
                    <span className="inline-flex items-center gap-1.5">
                      <Icon name="thumbUp" className="size-3.5" />
                      {fill(s.helpful, { n: n(proof.helpful) })}
                    </span>
                  ) : <span />}
                  <Link href={`/p/${proof.id}`} className="share-link">
                    {s.proof.read}
                    <Icon name="arrow" />
                  </Link>
                </div>
              </figure>
            )}
            {side === 'video' && video && (
              <div className="share-hero-video">
                <PublicIntro ree={ree} video={video} autoPlay={one(query.video) === '1'} />
              </div>
            )}
          </div>
        </article>

        {product && <ProductSections product={product} ree={ree} ready={ready} t={t} />}

        {ready ? (
          <section className="share-band share-ask-band" aria-labelledby="share-ask">
            <div className="share-wrap">
              <h2 id="share-ask" className="share-h2 [overflow-wrap:anywhere]">{ask}</h2>
              <p className="share-sub">
                {!user && ree.visitorAsks ? fill(s.closing.visitor, { owner: ree.ownerName }) : [ree.takesPosts ? s.closing.body : s.closing.privateOnly, s.closing.cost].join(locale === 'zh' ? '' : ' ')}
              </p>
              <div className={`share-ask-grid${questions.length ? ' has-topics' : ''}`}>
                {questions.length > 0 && (
                  <div className="min-w-0">
                    <h3 id="share-topics" className="share-h3">{s.topics}</h3>
                    <p className="share-note">{s.topicsHint}</p>
                    <TryQuestions slug={ree.slug} questions={questions} live />
                  </div>
                )}
                <div className="share-ask-box min-w-0">
                  <ReeAsk
                    ree={{ id: ree.id, slug: ree.slug, name: ree.name }}
                    option={askOption(ree, own)}
                    takesPosts={ree.takesPosts}
                    signedIn={Boolean(user)}
                    loginHref={`/login?returnTo=${encodeURIComponent(`/s/${ree.slug}#${REE_ASK_ANCHOR}`)}`}
                    share={user && !own ? ree.slug : null}
                    visitorAsk={ree.visitorAsks}
                  />
                </div>
              </div>
            </div>
          </section>
        ) : (
          questions.length > 0 && (
            <section className="share-band share-ask-band" aria-labelledby="share-topics">
              <div className="share-wrap">
                <h2 id="share-topics" className="share-h2">{s.topics}</h2>
                <p className="share-sub">{s.preparing}</p>
                <div className="share-ask-grid">
                  <TryQuestions slug={ree.slug} questions={questions} live={false} />
                </div>
              </div>
            </section>
          )
        )}

        {listed.length > 0 && (
          <section className="share-band" aria-labelledby="share-picks">
            <div className="share-wrap">
              <h2 id="share-picks" className="share-h2">{s.picks}</h2>
              <p className="share-sub">{fill(s.picksCount, { n: n(picks.total) })}</p>
              <ul className="share-list share-picks">
                {listed.map((post) => (
                  <li key={post.id} className="share-qa">
                    <div className="min-w-0">
                      <p className="share-note">{fill(s.proof.asked, { name: askerName(post, t) })}</p>
                      <Link href={`/p/${post.id}`} className="share-qa-question">
                        {post.question}
                      </Link>
                    </div>
                    <div className="min-w-0">
                      <p className="share-excerpt">{excerpt(post.answers[0]!.text)}</p>
                      <Cites post={post} label={s.proof.cited} />
                      {post.helpful > 0 && (
                        <p className="share-note mt-3 inline-flex items-center gap-1.5">
                          <Icon name="thumbUp" className="size-3.5" />
                          {fill(s.helpful, { n: n(post.helpful) })}
                        </p>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
              <Link href={`/r/${ree.slug}`} className="share-link mt-6">
                {fill(s.allAnswers, { n: n(picks.total) })}
                <Icon name="arrow" />
              </Link>
            </div>
          </section>
        )}

        {video && side !== 'video' && (
          <section className="share-band" aria-labelledby="share-video">
            <div className="share-wrap">
              <h2 id="share-video" className="share-h2">{t.discover.public.video}</h2>
              <div className="share-video mt-10">
                <PublicIntro ree={ree} video={video} autoPlay={one(query.video) === '1'} />
              </div>
            </div>
          </section>
        )}

        {ready && <Knowledge ree={ree} mix={mix} cited={cited} t={t} n={n} />}
      </div>
    </ShareFrame>
  );
}

/**
 * The product style's own bands: 主要功能, each with 问问这个 when it can
 * be asked, and 规格参数 -- the owner's words as typed. Neither shows when
 * it is empty.
 */
function ProductSections({ product, ree, ready, t }: { product: ProductSheet; ree: PublicRee; ready: boolean; t: Messages }) {
  const p = t.share.page.product;
  return (
    <>
      {product.features.length > 0 && (
        <section className="share-band" aria-labelledby="share-features">
          <div className="share-wrap">
            <h2 id="share-features" className="share-h2">{p.features}</h2>
            {ready && <p className="share-sub">{p.featuresLede}</p>}
            <ol className={`share-features n-${product.features.length}`}>
              {product.features.map((feature, index) => (
                <li key={`${index}-${feature.title}`} className="share-feature">
                  <span className="share-feature-index" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
                  <h3 className="share-h3 mt-6 [overflow-wrap:anywhere]">{feature.title}</h3>
                  {feature.body && <p className="share-feature-body">{feature.body}</p>}
                  {ready && (
                    <AskAbout slug={ree.slug} question={fill(p.askAboutQuestion, { feature: feature.title })}>
                      {p.askAbout}
                    </AskAbout>
                  )}
                </li>
              ))}
            </ol>
          </div>
        </section>
      )}
      {product.specs.length > 0 && (
        <section className="share-band" aria-labelledby="share-specs">
          <div className="share-wrap share-specs-grid">
            <div className="min-w-0">
              <h2 id="share-specs" className="share-h2">{p.specs}</h2>
              <p className="share-sub">{fill(p.specsLede, { owner: ree.ownerName, name: ree.name })}</p>
            </div>
            <dl className="share-specs">
              {product.specs.map((spec, index) => (
                <div key={`${index}-${spec.label}`}>
                  <dt>{spec.label}</dt>
                  <dd>{spec.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>
      )}
    </>
  );
}

/** 它的回答从哪里来: its sources by kind, and the ones its public answers cited. */
function Knowledge({ ree, mix, cited, t, n }: { ree: PublicRee; mix: Awaited<ReturnType<typeof reeSourceMix>>; cited: Awaited<ReturnType<typeof reeCitedSources>>; t: Messages; n: (value: number) => string }) {
  const k = t.share.page.knows;
  const total = mix.reduce((sum, entry) => sum + entry.count, 0);
  if (!total && !cited.length) return null;
  return (
    <section className="share-band" aria-labelledby="share-knows">
      <div className="share-wrap">
        <h2 id="share-knows" className="share-h2">{k.heading}</h2>
        <p className="share-sub">{fill(k.lede, { name: ree.name, n: n(ree.sources) })}</p>
        <div className="share-knows-grid">
          {total > 0 && (
            <div className="min-w-0">
              <p className="share-big">
                {n(ree.sources)}
                <span>{t.share.page.facts.sources}</span>
              </p>
              <h3 className="share-h3 mt-10">{k.mix}</h3>
              <div className="share-mix-bar mt-4" aria-hidden="true">
                {mix.map((entry) => (
                  <span key={entry.kind} style={{ flexGrow: entry.count, flexBasis: 0 }} />
                ))}
              </div>
              <ul className="share-mix">
                {mix.map((entry) => (
                  <li key={entry.kind}>
                    <Icon name={KIND_ICONS[entry.kind]} className="size-4 text-[color:var(--tone)]" />
                    {t.common.kinds[entry.kind]}
                    <strong>{n(entry.count)}</strong>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {cited.length > 0 && (
            <div className="min-w-0">
              <h3 className="share-h3">{k.cited}</h3>
              <ul className="share-cited">
                {cited.map((entry) => (
                  <li key={entry.knowledgeId}>
                    <span className="share-cited-tile">
                      <Icon name={KIND_ICONS[entry.kind]} className="size-5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <strong title={entry.title}>{entry.title}</strong>
                      <span className="share-note">
                        {t.common.kinds[entry.kind]} · {entry.answers === 1 ? k.citedOne : fill(k.citedCount, { n: n(entry.answers) })}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
