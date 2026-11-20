import { currentPricing } from '@/lib/services/pricing';
import { welcomeCredits } from '@/lib/services/signup-reward';
import { fill, formatNumber } from '@/i18n/format';
import { ProductPrice, PromotionNotice, pricingFaqValues } from '@/components/site/product-price';
import type { Metadata } from 'next';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { HOME_EXAMPLE_REES } from '@/lib/constants';
import { currentUser } from '@/lib/http/session';
import { activeRees } from '@/lib/services/explore';
import { favoriteReeIds } from '@/lib/services/ree-favorites';
import { PlayIntroButton } from '@/components/video/video-cover';
import { serverMessages } from '@/i18n/server';
import { Icon, type IconName } from '@/components/ui/icons';
import { ReeAvatar } from '@/components/ui/ree-avatar';
import { DemoTrigger, HomeDemo } from '@/components/site/home-demo';
import { RoleBadge } from '@/components/discover/role-badge';
import { ReeFavoriteButton } from '@/components/rees/ree-favorite-button';
import { publicPage, SITE_NAME } from '@/lib/seo';
import { publicCopyValues } from '@/lib/services/public-copy';
import { ContentPage } from '@/components/site/content-page';
import '@/components/site/site.css';

export async function generateMetadata(): Promise<Metadata> {
  const { t, locale } = await serverMessages();
  return publicPage({ path: '/about', title: `${t.site.visitor.aboutTitle} · ${SITE_NAME}`, absoluteTitle: true, description: t.site.seo.description, locale });
}

const FAQ = ['q1', 'q2', 'q8', 'q3', 'q4'] as const;

/**
 * `/about` (了解 RE0; until v5 this was `/`, prototype `#/`, suite.js
 * `home`): the answer example, the six kinds of source, how it works,
 * example Rees with their 15-second introductions, the price in brief, and
 * the FAQ. `/` is now the feed (app/(product)/page.tsx). In the shell's
 * wide column since v6, as cards (content-page.css); the answer demo keeps
 * its own look (site.css).
 */
export default async function AboutPage() {
  const [user, { t, locale }, examples, prices, welcome] = await Promise.all([currentUser(), serverMessages(), activeRees(HOME_EXAMPLE_REES, { officialOnly: true }), currentPricing(), welcomeCredits()]);
  const publicValues = await publicCopyValues(t, locale);
  const favoriteIds = user ? await favoriteReeIds(user.id, examples.map(ree => ree.id)) : undefined;
  const h = t.site.home;
  const createHref = user ? '/rees/new' : `/login?returnTo=${encodeURIComponent('/rees/new')}`;
  const sources: [IconName, keyof typeof h.sources][] = [
    ['file', 'document'],
    ['text', 'markdown'],
    ['audio', 'audio'],
    ['github', 'github'],
    ['globe', 'web'],
    ['text', 'notes'],
  ];
  const values = { ...pricingFaqValues(prices, locale, t.site.prices), ...publicValues };
  return (
    <ContentPage title={t.site.visitor.aboutTitle} heading={false}>
      <section className="xp-hero">
        <div>
          <p className="eyebrow">{h.pill}</p>
          <h1 className="mt-2">
            {h.headline1}
            {h.headline2}
            <em>{h.headlineEm}</em>
          </h1>
          <p>
            {h.lede1}
            <br />
            {h.lede2}
          </p>
          <div className="xp-hero-actions">
            <Link href={createHref} className="btn btn-sm">
              {h.ctaCreate}
              <Icon name="arrow" className="size-4" />
            </Link>
            <DemoTrigger label={h.ctaDemo} />
          </div>
          <div className="xp-hero-checks">
            {welcome.credits > 0 && (
              <span>
                <Icon name="check" />
                {fill(h.trialCredits, { welcomeCredits: formatNumber(welcome.credits, locale) })}
              </span>
            )}
            <span>
              <Icon name="check" />
              {h.trialScope}
            </span>
          </div>
        </div>
        <HomeDemo />
      </section>

      <section className="xp-card">
        <div className="xp-head">
          <h2>{h.sourcesLead}</h2>
        </div>
        <div className="xp-sources">
          {sources.map(([icon, key]) => (
            <span key={key} className="tag">
              <Icon name={icon} />
              {h.sources[key]}
            </span>
          ))}
        </div>
      </section>

      <section>
        <div className="xp-head">
          <p className="eyebrow">A SMALL IDEA. A COMPLETE EXPERIENCE.</p>
          <h2>
            {h.featureTitle1}
            {h.featureTitle2}
          </h2>
          <p>
            {h.featureLede1}
            {h.featureLede2}
          </p>
        </div>
        <div className="xp-grid3">
          <article className="xp-feature">
            <div className="xp-feature-art">
              {(
                [
                  ['file', 'product-notes.md'],
                  ['audio', 'team-conversation.m4a'],
                  ['github', 'your-repository'],
                ] as const
              ).map(([icon, name]) => (
                <span key={name} className="tag">
                  <Icon name={icon} />
                  {name}
                </span>
              ))}
            </div>
            <b>01 / TEACH</b>
            <h3>{h.teach.title}</h3>
            <p>{h.teach.body}</p>
          </article>
          <article className="xp-feature">
            <div className="xp-feature-quote">
              “{h.ask.quote1}
              {h.ask.quote2}”
              <small>
                <Icon name="file" /> {h.ask.cite}
              </small>
            </div>
            <b>02 / ASK</b>
            <h3>{h.ask.title}</h3>
            <p>{h.ask.body}</p>
          </article>
          <article className="xp-feature">
            <div className="xp-feature-art">
              <ReeAvatar size="sm" />
              <ReeAvatar color="lilac" size="sm" />
              <ReeAvatar color="sage" size="sm" />
              <span>{h.connect.caption}</span>
            </div>
            <b>03 / CONNECT</b>
            <h3>{h.connect.title}</h3>
            <p>{h.connect.body}</p>
          </article>
        </div>
      </section>

      <section>
        <div className="xp-head">
          <p className="eyebrow">LESS SETUP. MORE ANSWERS.</p>
          <h2>
            {h.workflowTitle}
            {h.workflowEm}
          </h2>
          <Link href={createHref} className="text-link">
            {h.start}
            <Icon name="arrow" className="size-3.5" />
          </Link>
        </div>
        <div className="xp-grid3">
          {(
            [
              ['01', 'step1'],
              ['02', 'step2'],
              ['03', 'step3'],
            ] as const
          ).map(([number, key]) => (
            <article key={key} className="xp-step">
              <b>{number}</b>
              <h3>{h[key].title}</h3>
              <p>{h[key].body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="scroll-mt-24" id="home-ree-examples">
        <div className="xp-head">
          <p className="eyebrow">A COMPANION FOR EVERY CURIOSITY</p>
          <h2>
            {h.examplesTitle}
            {h.examplesEm}
          </h2>
          <Link href="/explore" className="text-link">
            {h.more}
            <Icon name="arrow" className="size-3.5" />
          </Link>
          <p>{examples.length ? t.discover.home.note : h.examplesNote}</p>
        </div>
        <div className="xp-grid3">
          {/* Official Rees only, pinned then most active; the illustrative three only while there are none. */}
          {examples.length
            ? examples.map((ree) => (
                <article key={ree.id} className="xp-ree">
                  <div className="xp-ree-top">
                    <ReeAvatar avatar={ree.avatarBlob} color={ree.color} size="sm" />
                    {/* A Ree with an introduction plays it here (15s). */}
                    <div className="flex items-center gap-1">
                      {ree.video && <PlayIntroButton video={ree.video} name={ree.name} href={`/r/${ree.slug}`} linkLabel={t.video.dialog.details} label="15s" className="btn-ghost btn-sm" />}
                      {ree.ownerId !== user?.id && <ReeFavoriteButton ree={ree} favorite={favoriteIds?.includes(ree.id)} returnTo="/about#home-ree-examples" />}
                    </div>
                  </div>
                  <h3>
                    {ree.name}
                    <RoleBadge role={ree.role} />
                  </h3>
                  <p className="line-clamp-3">{ree.description}</p>
                  <div className="xp-ree-foot">
                    <span className="mono">
                      {ree.price} <small>{h.perAnswer}</small>
                    </span>
                    <Link href={`/r/${ree.slug}`} className="text-link">
                      {h.details}
                      <Icon name="arrow" className="size-3.5" />
                    </Link>
                  </div>
                </article>
              ))
            : (
                [
                  ['design', 'default'],
                  ['code', 'lilac'],
                  ['read', 'sand'],
                ] as const
              ).map(([key, color]) => (
                <article key={key} className="xp-ree">
                  <div className="xp-ree-top">
                    <ReeAvatar color={color} size="sm" />
                    <span className="tag">{h.example}</span>
                  </div>
                  <h3>{h.examples[key].name}</h3>
                  <p>{h.examples[key].body}</p>
                  <div className="xp-ree-foot">
                    <span className="mono">
                      {h.examples[key].fee} <small>{h.perAnswer}</small>
                    </span>
                  </div>
                </article>
              ))}
        </div>
      </section>

      <section className="xp-card xp-plan">
        <div>
          <p className="eyebrow">SIMPLE CREDITS. CLEAR VALUE.</p>
          <h2 className="text-[15px] font-[750]">
            {h.priceTitle1}
            {h.priceTitle2}
          </h2>
          <p>
            {h.priceBody1}
            <br />
            {h.priceBody2}
          </p>
          <Link href="/pricing" className="btn-secondary btn-sm">
            {h.priceCta}
            <Icon name="arrow" className="size-4" />
          </Link>
        </div>
        <div className="xp-tier">
          <div className="flex items-center justify-between">
            <span className="eyebrow">PLAN</span>
            <span className="tag blue">{h.monthly}</span>
          </div>
          <p className="xp-price">
            <ProductPrice price={prices.plan} kind="plan" locale={locale} labels={t.site.prices} />
            <small>/ {h.perMonth}</small>
          </p>
          <PromotionNotice price={prices.plan} kind="plan" locale={locale} labels={t.site.prices} />
          <p className="xp-credits">{formatNumber(prices.plan.credits, locale)} credits</p>
          <ul>
            {[h.planPerk1, h.planPerk2, h.planPerk3].map((perk) => (
              <li key={perk}>
                <Icon name="check" />
                {perk}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="xp-card">
        <div className="xp-head">
          <p className="eyebrow">{t.site.faq.eyebrow}</p>
          <h2>
            {h.faqTitle1}
            {h.faqTitle2}
          </h2>
        </div>
        <div className="xp-faq">
          {FAQ.map((key) => (
            <details key={key}>
              <summary>
                {t.site.faq[key].q}
                <Icon name="plus" />
              </summary>
              <p>{fill(t.site.faq[key].a, values)}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="xp-cta">
        <div>
          <p className="eyebrow text-[#c4cce0]">YOUR KNOWLEDGE. A NEW POSSIBILITY.</p>
          <h2>
            {h.finalTitle}
            <em>{h.finalEm}</em>
          </h2>
          {welcome.credits > 0 && <p>{fill(h.finalNote, { welcomeCredits: formatNumber(welcome.credits, locale) })}</p>}
        </div>
        <Link href={createHref} className="btn btn-sm">
          {h.ctaCreate}
          <Icon name="arrow" className="size-4" />
        </Link>
      </section>
    </ContentPage>
  );
}
