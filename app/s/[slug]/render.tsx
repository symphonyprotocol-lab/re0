import type { Metadata } from 'next';
import { Bricolage_Grotesque } from 'next/font/google';
import { cookies } from 'next/headers';
import { notFound, permanentRedirect, redirect } from 'next/navigation';
import { ShowcaseBeacon, TrackedLink } from '@/components/showcase/showcase-beacon';
import { ShowcaseChat } from '@/components/showcase/showcase-chat';
import { ShowcaseUnlock } from '@/components/showcase/showcase-unlock';
import { LocaleSwitcher } from '@/components/site/locale-switcher';
import { Re0Mark } from '@/components/ui/icons';
import { showcaseFieldsFor, showcasePath, type ShowcaseField } from '@/lib/domain/showcase';
import { LocaleProvider } from '@/lib/i18n/client';
import { messagesFor, type Dictionary } from '@/lib/i18n/dictionary';
import { fill } from '@/lib/i18n/format';
import { isLocale, LOCALE_COOKIE, type Locale } from '@/lib/i18n/locale';
import { showcaseGateFor } from '@/lib/http/showcase-gate';
import { publicUrl } from '@/lib/site/origin';
import { PREVIEW_PARAM, showcaseLookup } from './lookup';

/**
 * The page's display face, for the name and the headings. Loaded here and
 * not site-wide: the page speaks in the owner's voice, not ours, and the
 * rest of the site never shows it. Chinese names fall through to the
 * system's CJK face, as any Latin display face would.
 */
const display = Bricolage_Grotesque({ subsets: ['latin'], variable: '--font-bricolage', axes: ['wdth'], display: 'swap' });

/**
 * A library shared as a page (lib/domain/showcase.ts): the company or the
 * product on top, in the owner's words, and the library's own Q&A under
 * it. Standalone on purpose -- no site header, no catalogue chrome -- since
 * the page is the owner's, sent to their customers, and the only trace of
 * us is the line at the foot. A page that is not published is a 404 like
 * a missing one; a slug the page used to have redirects to the current one.
 *
 * The language is the reader's choice when they have made one (the same
 * cookie the rest of the site honours), else the owner's setting for the
 * page: a visitor in Shanghai sent a Chinese page should not get English
 * because their browser says so.
 */
async function pageLocale(fallback: Locale): Promise<Locale> {
  const chosen = (await cookies()).get(LOCALE_COOKIE)?.value;
  return isLocale(chosen) ? chosen : fallback;
}

/** The address the page is canonical at: its own host when it has one, else `/s/{slug}` on ours. */
function canonicalOf(slug: string, customHost: string | null): string {
  return customHost ? `https://${customHost}/` : publicUrl(showcasePath(slug));
}

export async function showcaseMetadata(slug: string, preview: boolean, customHost: string | null): Promise<Metadata> {
  const found = await showcaseLookup(slug, preview);
  if (found.kind !== 'page') return { title: messagesFor('en').showcase.fallbackTitle, robots: { index: false } };
  const { page } = found;
  const content = page.document.content;
  /* A gated page tells a crawler, a chat app or a feed its name and nothing else. */
  const gate = page.preview ? 'open' : await showcaseGateFor(await cookies(), page.gate);
  const description = gate === 'open' ? content.tagline || content.summary.slice(0, 160) || undefined : undefined;
  return {
    title: { absolute: content.name },
    description,
    robots: page.indexable && gate === 'open' ? { index: true, follow: true } : { index: false, follow: false },
    alternates: { canonical: canonicalOf(page.slug, customHost) },
    openGraph: {
      title: content.name,
      description,
      type: 'website',
      url: canonicalOf(page.slug, customHost),
    },
    twitter: { card: 'summary_large_image', title: content.name, description },
  };
}

/** A section heading in the page's own voice: the display face, sentence case, no label above it. */
function Heading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="font-display text-[24px] leading-[1.2] font-semibold tracking-[-0.01em] text-ink sm:text-[28px]">
      {children}
    </h2>
  );
}

/**
 * A fact as the draft writes it -- "Founded: 2021", "领域：网页分享与托管" --
 * split at its first colon so the list reads as a table; one without a colon
 * is a line on its own.
 */
function splitFact(fact: string): [string | null, string] {
  const at = fact.search(/[:：]/);
  if (at <= 0 || at >= fact.length - 1) return [null, fact];
  return [fact.slice(0, at).trim(), fact.slice(at + 1).trim()];
}

/**
 * The page itself, rendered at `/s/{slug}` on our host or at `/` on the
 * owner's own host (app/s/by-host); `customHost` says which, for the links
 * the page prints about itself.
 *
 * It is laid out as the owner's landing page, in their accent and their
 * words. One thing is loud: the library answering, as a live window beside
 * the name, because a page that answers questions from the owner's own
 * documents is what no other landing page has. Everything else is quiet --
 * the screenshot as a product shot when there is one, the facts as a table,
 * a tinted band for who it is for and what it costs -- so the owner's
 * content, not the frame, is what a visitor reads.
 */
export async function ShowcaseScreen({ slug, preview, customHost }: { slug: string; preview: boolean; customHost: string | null }) {
  const found = await showcaseLookup(slug, preview);
  if (found.kind === 'redirect') {
    if (customHost) redirect(`https://${customHost}/`);
    permanentRedirect(showcasePath(found.slug));
  }
  if (found.kind !== 'page') notFound();
  const { page } = found;
  const locale = await pageLocale(page.locale);
  const t = messagesFor(locale);
  const s: Dictionary['showcase'] = t.showcase;
  const content = page.document.content;

  /*
   * The gate (lib/domain/showcase.ts `showcaseGate`): an expired page says
   * so and nothing more; a locked one asks for the password and sends none
   * of its content in the HTML. The owner's preview walks through both.
   */
  const gate = page.preview ? 'open' : await showcaseGateFor(await cookies(), page.gate);
  if (gate !== 'open') {
    return (
      <LocaleProvider locale={locale} messages={t}>
        <div className="product-surface site-surface flex min-h-screen flex-col items-center justify-center gap-6 bg-subtle px-5 py-16 text-ink">
          <div className="flex flex-col items-center gap-3 text-center">
            {page.hasLogo && gate === 'locked' ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={`${showcasePath(page.slug)}/logo?v=${encodeURIComponent(page.updatedAt)}`} alt="" width={64} height={64} className="size-16 rounded-xl border border-line bg-card object-contain p-1" />
            ) : (
              <span aria-hidden className="flex size-16 items-center justify-center rounded-xl text-[26px] font-semibold text-white" style={{ background: page.accent }}>
                {(content.name.trim()[0] ?? '?').toUpperCase()}
              </span>
            )}
            <h1 className="text-[24px] leading-[1.25] font-semibold text-ink">{content.name}</h1>
            <p className="max-w-[420px] text-[13.5px] leading-[1.6] text-muted">{gate === 'locked' ? s.gate.lockedBody : s.gate.expiredBody}</p>
          </div>
          {gate === 'locked' ? <ShowcaseUnlock slug={page.slug} accent={page.accent} /> : null}
        </div>
      </LocaleProvider>
    );
  }
  const shown = new Set<ShowcaseField>(showcaseFieldsFor(page.kind));
  const has = (field: ShowcaseField) => {
    if (!shown.has(field)) return false;
    const value = content[field];
    return Array.isArray(value) ? value.length > 0 : value.length > 0;
  };
  const version = encodeURIComponent(page.updatedAt) + (page.preview ? `&${PREVIEW_PARAM}=1` : '');
  const brandHref = `${publicUrl('/')}?ref=showcase&s=${encodeURIComponent(page.slug)}`;
  /* The accent, thinned: the one colour the page has, used for its tints and its glow. */
  const tint = (percent: number) => `color-mix(in srgb, ${page.accent} ${percent}%, transparent)`;
  const container = 'mx-auto w-full max-w-[1120px] px-5 sm:px-8';
  const primaryCta = 'inline-flex h-11 items-center rounded-lg px-5 text-[14px] font-medium text-white transition-opacity hover:opacity-90';
  const secondaryCta = 'inline-flex h-11 items-center rounded-lg border border-line bg-card px-5 text-[14px] font-medium text-ink hover:bg-subtle';

  const ctas = has('ctas') ? (
    <div className="flex flex-wrap items-center gap-3">
      {content.ctas.map((cta, at) => (
        <TrackedLink
          key={`${at}-${cta.url}`}
          slug={page.slug}
          href={cta.url}
          className={at === 0 ? primaryCta : secondaryCta}
          style={at === 0 ? { background: page.accent } : undefined}
        >
          {cta.label}
        </TrackedLink>
      ))}
    </div>
  ) : null;

  return (
    <LocaleProvider locale={locale} messages={t}>
      <div
        className={`${display.variable} product-surface site-surface flex min-h-screen flex-col bg-card text-ink`}
        style={{ ['--showcase-accent' as string]: page.accent }}
      >
        {page.preview ? (
          <p className="bg-ink px-5 py-2 text-center text-[12px] text-white">{s.previewBanner}</p>
        ) : (
          <ShowcaseBeacon slug={page.slug} />
        )}

        {/* The hero: the owner's words on the left, the library answering on the right. */}
        <header className="relative overflow-hidden">
          <div
            aria-hidden
            className="pointer-events-none absolute -top-40 -right-44 size-[380px] rounded-full lg:-top-56 lg:-right-40 lg:size-[680px]"
            style={{ background: tint(9) }}
          />
          <div className={`${container} relative grid grid-cols-1 items-start gap-12 pt-12 pb-14 lg:grid-cols-[minmax(0,1fr)_440px] lg:gap-16 lg:pt-20 lg:pb-24`}>
            <div className="flex flex-col items-start">
              {page.hasLogo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`${showcasePath(page.slug)}/logo?v=${version}`}
                  alt=""
                  width={72}
                  height={72}
                  className="size-[72px] rounded-2xl border border-line bg-card object-contain p-1.5"
                />
              ) : (
                <span
                  aria-hidden
                  className="font-display flex size-[72px] items-center justify-center rounded-2xl text-[30px] font-semibold text-white"
                  style={{ background: page.accent }}
                >
                  {(content.name.trim()[0] ?? '?').toUpperCase()}
                </span>
              )}
              <h1 className="font-display mt-7 max-w-[16ch] text-[40px] leading-[1.05] font-semibold tracking-[-0.025em] text-ink sm:text-[56px]">
                {content.name}
              </h1>
              {content.tagline ? (
                <p className="mt-4 max-w-[32ch] text-[20px] leading-[1.4] text-steel sm:text-[24px]">{content.tagline}</p>
              ) : null}
              {content.summary ? (
                <p className="mt-6 max-w-[58ch] text-[15.5px] leading-[1.75] whitespace-pre-line text-ink/85">{content.summary}</p>
              ) : null}
              {ctas ? <div className="mt-8">{ctas}</div> : null}
              {has('links') ? (
                <p className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
                  {content.links.map((link, at) => (
                    <a
                      key={`${at}-${link.url}`}
                      href={link.url}
                      target="_blank"
                      rel="noopener nofollow"
                      className="underline-offset-[3px] hover:underline"
                      style={{ color: page.accent }}
                    >
                      {link.label}
                    </a>
                  ))}
                </p>
              ) : null}
            </div>

            {/* The ask window. One panel holds the transcript (or the starter
                questions while there is none) and the composer; it scrolls
                inside its own frame, so a long exchange never pushes the
                page about. */}
            <aside className="w-full lg:sticky lg:top-6">
              <section
                className="flex max-h-[640px] min-h-[440px] flex-col overflow-hidden rounded-2xl border border-line bg-card"
                style={{ boxShadow: `0 32px 72px -32px ${tint(55)}` }}
              >
                <div className="px-5 py-4 text-white sm:px-6" style={{ background: page.accent }}>
                  <p className="font-display text-[19px] leading-[1.25] font-semibold">{s.askTitle}</p>
                  <p className="mt-1 text-[12.5px] leading-[1.5] text-white/80">{fill(s.askHint, { name: content.name })}</p>
                </div>
                <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
                  <ShowcaseChat
                    slug={page.slug}
                    accent={page.accent}
                    ready={page.ready}
                    preview={Boolean(page.preview)}
                    starterQuestions={page.starterQuestions}
                    fallbackCta={content.ctas[0] ?? content.links[0] ?? null}
                    ownerName={content.name}
                  />
                </div>
              </section>
            </aside>
          </div>
        </header>

        {/* The product shot, when the owner uploaded one: the page's one photograph. */}
        {page.hasScreenshot ? (
          <section className="border-t border-line bg-subtle">
            <figure className={`${container} flex flex-col gap-4 py-14`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`${showcasePath(page.slug)}/screenshot?v=${version}`}
                alt={fill(s.screenshotAlt, { name: content.name })}
                className="w-full rounded-xl border border-line bg-card object-cover"
                style={{ boxShadow: `0 40px 90px -44px ${tint(60)}` }}
              />
              {content.tagline ? <figcaption className="text-[13px] text-muted">{content.tagline}</figcaption> : null}
            </figure>
          </section>
        ) : null}

        {/* A company: the facts, as the table they are. */}
        {has('facts') ? (
          <section className="border-t border-line">
            <div className={`${container} py-16`}>
              <Heading>{s.factsTitle}</Heading>
              <dl className="mt-6 grid grid-cols-1 gap-x-16 lg:grid-cols-2">
                {content.facts.map((fact, at) => {
                  const [label, value] = splitFact(fact);
                  return (
                    <div
                      key={`${at}-${fact}`}
                      className="grid grid-cols-[minmax(0,8.5rem)_minmax(0,1fr)] gap-4 border-b border-line py-3.5 text-[15px] leading-[1.5]"
                    >
                      {label ? <dt className="text-muted">{label}</dt> : null}
                      <dd className={label ? 'text-ink' : 'col-span-2 text-ink'}>{value}</dd>
                    </div>
                  );
                })}
              </dl>
            </div>
          </section>
        ) : null}

        {/* A product: what it does, three to a row, with nothing boxed. */}
        {has('features') ? (
          <section className="border-t border-line">
            <div className={`${container} py-16`}>
              <Heading>{s.featuresTitle}</Heading>
              <ul className="mt-8 grid grid-cols-1 gap-x-10 gap-y-9 sm:grid-cols-2 lg:grid-cols-3">
                {content.features.map((feature, at) => (
                  <li key={`${at}-${feature.title}`} className="flex flex-col gap-2">
                    <span aria-hidden className="size-2.5 rounded-[3px]" style={{ background: page.accent }} />
                    <span className="font-display text-[17px] leading-[1.3] font-semibold text-ink">{feature.title}</span>
                    {feature.body ? <span className="text-[14px] leading-[1.65] text-muted">{feature.body}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          </section>
        ) : null}

        {/* Who it is for and what it costs, on the one tinted band. */}
        {has('audience') || has('pricing') ? (
          <section className="border-t border-line" style={{ background: tint(6) }}>
            <div className={`${container} grid grid-cols-1 gap-12 py-16 lg:grid-cols-2 lg:gap-20`}>
              {has('audience') ? (
                <div>
                  <Heading>{s.audienceTitle}</Heading>
                  <p className="mt-4 max-w-[48ch] text-[16px] leading-[1.7] text-ink">{content.audience}</p>
                </div>
              ) : null}
              {has('pricing') ? (
                <div>
                  <Heading>{s.pricingTitle}</Heading>
                  <p className="mt-4 max-w-[48ch] text-[16px] leading-[1.7] text-ink">{content.pricing}</p>
                </div>
              ) : null}
            </div>
          </section>
        ) : null}

        {/* The pitch once more, with the buttons, where a reader who scrolled to the end decides. */}
        {ctas ? (
          <section className="border-t border-line">
            <div className={`${container} flex flex-col items-start gap-7 py-16 sm:flex-row sm:items-center sm:justify-between`}>
              <p className="font-display max-w-[26ch] text-[28px] leading-[1.2] font-semibold tracking-[-0.015em] text-ink sm:text-[32px]">
                {content.tagline || content.name}
              </p>
              {ctas}
            </div>
          </section>
        ) : null}

        <footer className="mt-auto border-t border-line bg-subtle">
          <div className={`${container} flex flex-wrap items-center justify-between gap-3 py-5 text-[12px] text-muted`}>
            {page.showBranding ? (
              <a href={brandHref} className="inline-flex items-center gap-1.5 hover:text-ink" rel="noopener">
                <Re0Mark size={14} />
                <span>{s.poweredBy}</span>
                <span className="text-brandink">{s.createYours}</span>
              </a>
            ) : (
              <span />
            )}
            <LocaleSwitcher />
          </div>
        </footer>
      </div>
    </LocaleProvider>
  );
}
