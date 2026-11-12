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
import { JsonLd } from '@/components/site/json-ld';
import { publicPage, siteJsonLd, SITE_NAME } from '@/lib/seo';

export async function generateMetadata(): Promise<Metadata> {
  const { t, locale } = await serverMessages();
  return publicPage({ path: '/', title: `${t.site.home.title} · ${SITE_NAME}`, absoluteTitle: true, description: t.site.seo.description, locale });
}

const FAQ = ['q1', 'q2', 'q3', 'q4'] as const;

/**
 * `/` (prototype `#/`, suite.js `home`): the answer example, the six kinds of
 * source, how it works, example Rees with their 15-second introductions, the
 * price in brief, and the FAQ. Markup and class names follow the prototype;
 * components/site/site.css carries its styles.
 */
export default async function HomePage() {
  const [user, { t, locale }, examples, prices, welcome] = await Promise.all([currentUser(), serverMessages(), activeRees(HOME_EXAMPLE_REES, { officialOnly: true }), currentPricing(), welcomeCredits()]);
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
  return (
    <div className="site-home">
      <JsonLd data={siteJsonLd(t.site.seo.description)} />
      <section className="home-hero marketing-wrap">
        <div className="home-hero-copy">
          <div className="launch-pill">
            <i className="dot" aria-hidden="true" />
            {h.pill}
            <Icon name="arrow" />
          </div>
          <h1>
            {h.headline1}
            <br />
            {h.headline2}
            <em>{h.headlineEm}</em>
          </h1>
          <p>
            {h.lede1}
            <br />
            {h.lede2}
          </p>
          <div className="home-hero-actions">
            <Link href={createHref} className="btn large">
              {h.ctaCreate} <Icon name="arrow" />
            </Link>
            <DemoTrigger label={h.ctaDemo} />
          </div>
          <div className="home-trial">
            {welcome.credits > 0 && <span>
              <Icon name="check" />
              {fill(h.trialCredits, { welcomeCredits: formatNumber(welcome.credits, locale) })}
            </span>}
            <span>
              <Icon name="check" />
              {h.trialScope}
            </span>
          </div>
        </div>
        <HomeDemo />
        <span className="hero-index mono">01 — KNOWLEDGE, GIVEN A VOICE</span>
      </section>

      <section className="source-strip">
        <div className="marketing-wrap">
          <span>{h.sourcesLead}</span>
          <div>
            {sources.map(([icon, key]) => (
              <span key={key}>
                <Icon name={icon} />
                {h.sources[key]}
              </span>
            ))}
          </div>
        </div>
      </section>

      <section className="marketing-wrap home-section">
        <div className="section-intro">
          <p className="eyebrow">A SMALL IDEA. A COMPLETE EXPERIENCE.</p>
          <h2>
            {h.featureTitle1}
            <br />
            {h.featureTitle2}
          </h2>
          <p>
            {h.featureLede1}
            <br />
            {h.featureLede2}
          </p>
        </div>
        <div className="home-feature-grid">
          <article className="feature-knowledge">
            <div className="feature-illustration">
              {(
                [
                  ['file', 'product-notes.md'],
                  ['audio', 'team-conversation.m4a'],
                  ['github', 'your-repository'],
                ] as const
              ).map(([icon, name]) => (
                <div key={name} className="feature-file">
                  <Icon name={icon} />
                  <span>{name}</span>
                  <i className="dot" aria-hidden="true" />
                </div>
              ))}
            </div>
            <span className="eyebrow">01 / TEACH</span>
            <h3>{h.teach.title}</h3>
            <p>{h.teach.body}</p>
          </article>
          <article className="feature-citation">
            <div className="feature-quote">
              “{h.ask.quote1}
              <br />
              {h.ask.quote2}”<span className="feature-cite">1</span>
              <span>
                <Icon name="file" /> {h.ask.cite}
              </span>
            </div>
            <span className="eyebrow">02 / ASK</span>
            <h3>{h.ask.title}</h3>
            <p>{h.ask.body}</p>
          </article>
          <article className="feature-group">
            <div className="feature-avatars">
              <ReeAvatar className="dot-avatar" />
              <span>+</span>
              <ReeAvatar color="lilac" className="dot-avatar" />
              <span>+</span>
              <ReeAvatar color="sage" className="dot-avatar" />
              <div>{h.connect.caption}</div>
            </div>
            <span className="eyebrow">03 / CONNECT</span>
            <h3>{h.connect.title}</h3>
            <p>{h.connect.body}</p>
          </article>
        </div>
      </section>

      <section className="home-workflow">
        <div className="marketing-wrap">
          <div className="between home-section-head">
            <div>
              <p className="eyebrow">LESS SETUP. MORE CONVERSATION.</p>
              <h2>
                {h.workflowTitle}
                <em>{h.workflowEm}</em>
              </h2>
            </div>
            <Link href={createHref} className="text-link">
              {h.start}
              <Icon name="arrow" />
            </Link>
          </div>
          <div className="workflow-steps">
            {(
              [
                ['01', 'step1', 'ree'],
                ['02', 'step2', 'file'],
                ['03', 'step3', 'chat'],
              ] as const
            ).map(([number, key, icon]) => (
              <article key={key}>
                <span className="mono">{number}</span>
                <Icon name={icon} />
                <h3>{h[key].title}</h3>
                <p>{h[key].body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="marketing-wrap home-section scroll-mt-24" id="home-ree-examples">
        <div className="between home-section-head">
          <div>
            <p className="eyebrow">A COMPANION FOR EVERY CURIOSITY</p>
            <h2>
              {h.examplesTitle}
              <em>{h.examplesEm}</em>
            </h2>
            <span className="tiny muted">{examples.length ? t.discover.home.note : h.examplesNote}</span>
          </div>
          <div className="home-dot-row">
            {/* Step 4: official Rees only, pinned then most active; the illustrative three only while there are none. */}
            {examples.length
              ? examples.map((ree) => (
                  <article key={ree.id} className="card home-dot-card">
                    <div className="between">
                      <ReeAvatar avatar={ree.avatarBlob} color={ree.color} className="dot-avatar" />
                      {/* Step 7 (prototype home-dot-card "15s"): a Ree with an introduction plays it here. */}
                      <div className="flex items-center gap-1">
                        {ree.video && <PlayIntroButton video={ree.video} name={ree.name} href={`/r/${ree.slug}`} linkLabel={t.video.dialog.details} label="15s" className="btn ghost sm" />}
                        {ree.ownerId !== user?.id && <ReeFavoriteButton ree={ree} favorite={favoriteIds?.includes(ree.id)} returnTo="/#home-ree-examples" />}
                      </div>
                    </div>
                    <h3>
                      {ree.name}
                      <RoleBadge role={ree.role} />
                    </h3>
                    <p className="line-clamp-3">{ree.description}</p>
                    <div className="between">
                      <span className="mono">
                        {ree.price} <small>{h.perAnswer}</small>
                      </span>
                      <Link href={`/r/${ree.slug}`} className="text-link">
                        {h.details}
                        <Icon name="arrow" />
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
                  <article key={key} className="card home-dot-card">
                    <div className="between">
                      <ReeAvatar color={color} className="dot-avatar" />
                      <span className="tag">{h.example}</span>
                    </div>
                    <h3>{h.examples[key].name}</h3>
                    <p>{h.examples[key].body}</p>
                    <div className="between">
                      <span className="mono">
                        {h.examples[key].fee} <small>{h.perAnswer}</small>
                      </span>
                    </div>
                  </article>
                ))}
          </div>
          <div className="home-center-link">
            <Link href="/explore" className="text-link">
              {h.more}
              <Icon name="arrow" />
            </Link>
          </div>
        </div>
      </section>

      <section className="home-price-section">
        <div className="marketing-wrap">
          <div>
            <p className="eyebrow">SIMPLE CREDITS. CLEAR VALUE.</p>
            <h2>
              {h.priceTitle1}
              <br />
              {h.priceTitle2}
            </h2>
            <p>
              {h.priceBody1}
              <br />
              {h.priceBody2}
            </p>
            <Link href="/pricing" className="btn secondary">
              {h.priceCta}
              <Icon name="arrow" />
            </Link>
          </div>
          <div className="home-price-preview">
            <div className="between">
              <span>PLAN</span>
              <span className="tag blue">{h.monthly}</span>
            </div>
            <p>
              <strong><ProductPrice price={prices.plan} kind="plan" locale={locale} labels={t.site.prices} /></strong> / {h.perMonth}
            </p>
            <PromotionNotice price={prices.plan} kind="plan" locale={locale} labels={t.site.prices} />
            <h3>{formatNumber(prices.plan.credits, locale)} credits</h3>
            <div className="rule" />
            {[h.planPerk1, h.planPerk2, h.planPerk3].map((perk) => (
              <span key={perk}>
                <Icon name="check" />
                {perk}
              </span>
            ))}
          </div>
        </div>
      </section>

      <section className="marketing-wrap home-section home-faq">
        <div>
          <p className="eyebrow">{t.site.faq.eyebrow}</p>
          <h2>
            {h.faqTitle1}
            <br />
            {h.faqTitle2}
          </h2>
        </div>
        <div>
          {FAQ.map((key) => (
            <details key={key}>
              <summary>
                {t.site.faq[key].q}
                <Icon name="plus" />
              </summary>
              <p>{fill(t.site.faq[key].a, pricingFaqValues(prices, locale, t.site.prices))}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="marketing-wrap final-cta">
        <p className="eyebrow">YOUR KNOWLEDGE. A NEW POSSIBILITY.</p>
        <h2>
          {h.finalTitle}
          <em>{h.finalEm}</em>
        </h2>
        <Link href={createHref} className="btn large">
          {h.ctaCreate}
          <Icon name="arrow" />
        </Link>
        {welcome.credits > 0 && <p>{fill(h.finalNote, { welcomeCredits: formatNumber(welcome.credits, locale) })}</p>}
      </section>
    </div>
  );
}
