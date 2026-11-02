import type { Metadata } from 'next';
import Link from 'next/link';
import { currentUser } from '@/lib/http/session';
import { serverMessages } from '@/i18n/server';
import { Icon, type IconName } from '@/components/ui/icons';
import { ReeAvatar } from '@/components/ui/ree-avatar';
import { DemoTrigger, HomeDemo } from '@/components/site/home-demo';
import { Faq } from '@/components/site/faq';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: { absolute: `${t.site.home.title} · RE0` } };
}

/**
 * `/` (prototype `#/`): the interactive answer example, the six kinds of
 * source, how it works, example Rees, the 15-second introduction's slot
 * (the video itself is step 7), the price in brief, and the FAQ.
 */
export default async function HomePage() {
  const [user, { t }] = await Promise.all([currentUser(), serverMessages()]);
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
    <>
      <section className="mx-auto grid max-w-[1200px] items-center gap-12 px-4 pt-12 pb-16 sm:px-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:pt-20">
        <div className="min-w-0">
          <p className="inline-flex max-w-full items-center gap-2 rounded-full border border-[#dfe6f5] bg-wash px-3 py-1.5 text-[12px] text-muted">
            <i className="size-1.5 flex-none rounded-full bg-green" aria-hidden="true" />
            <span className="truncate">{h.pill}</span>
          </p>
          <h1 className="mt-6 text-[40px] leading-[1.12] font-extrabold tracking-tight sm:text-[56px]">
            {h.headline1}
            <br />
            {h.headline2}
            <em className="text-blue not-italic">{h.headlineEm}</em>
          </h1>
          <p className="mt-6 text-[16px] leading-relaxed text-muted">
            {h.lede1}
            <br />
            {h.lede2}
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href={createHref} className="btn min-h-12 px-5 text-[14px]">
              {h.ctaCreate}
              <Icon name="arrow" />
            </Link>
            <DemoTrigger label={h.ctaDemo} />
          </div>
          <div className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-[12px] text-muted">
            <span className="flex items-center gap-1.5">
              <Icon name="check" className="size-4 text-green" />
              {h.trialCredits}
            </span>
            <span className="flex items-center gap-1.5">
              <Icon name="check" className="size-4 text-green" />
              {h.trialScope}
            </span>
          </div>
        </div>
        <HomeDemo />
      </section>

      <section className="border-y border-line bg-wash">
        <div className="mx-auto flex max-w-[1200px] flex-col gap-4 px-4 py-6 sm:px-6 lg:flex-row lg:items-center">
          <span className="text-[13px] font-semibold text-muted lg:w-60">{h.sourcesLead}</span>
          <ul className="flex flex-wrap gap-x-6 gap-y-3 text-[13px]">
            {sources.map(([icon, key]) => (
              <li key={key} className="flex items-center gap-2">
                <Icon name={icon} className="size-4 text-blue" />
                {h.sources[key]}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="mx-auto max-w-[1200px] px-4 py-20 sm:px-6">
        <p className="eyebrow">A SMALL IDEA. A COMPLETE EXPERIENCE.</p>
        <h2 className="mt-3 text-[30px] leading-tight font-extrabold sm:text-[38px]">
          {h.featureTitle1}
          <br />
          {h.featureTitle2}
        </h2>
        <p className="mt-4 max-w-[560px] text-[14px] text-muted">{h.featureLede}</p>
        <div className="mt-10 grid gap-5 md:grid-cols-3">
          <article className="card flex flex-col p-6">
            <div className="flex flex-col gap-2 rounded-xl bg-wash p-4">
              {(['file', 'audio', 'github'] as const).map((icon, index) => (
                <span key={icon} className="flex items-center gap-2 rounded-lg border border-line bg-white px-3 py-2 font-mono text-[11px]">
                  <Icon name={icon} className="size-4 text-blue" />
                  {['product-notes.md', 'team-conversation.m4a', 'your-repository'][index]}
                  <i className="ml-auto size-1.5 rounded-full bg-green" aria-hidden="true" />
                </span>
              ))}
            </div>
            <span className="eyebrow mt-6">01 / TEACH</span>
            <h3 className="mt-2 text-[17px] font-bold">{h.teach.title}</h3>
            <p className="mt-2 text-[13px] leading-relaxed text-muted">{h.teach.body}</p>
          </article>
          <article className="card flex flex-col p-6">
            <div className="rounded-xl bg-wash p-4">
              <p className="text-[15px] leading-relaxed font-semibold">
                “{h.ask.quote}”<sup className="ml-1 font-mono text-blue">1</sup>
              </p>
              <span className="mt-3 flex items-center gap-1.5 text-[11px] text-muted">
                <Icon name="file" className="size-3.5" />
                {h.ask.cite}
              </span>
            </div>
            <span className="eyebrow mt-6">02 / ASK</span>
            <h3 className="mt-2 text-[17px] font-bold">{h.ask.title}</h3>
            <p className="mt-2 text-[13px] leading-relaxed text-muted">{h.ask.body}</p>
          </article>
          <article className="card flex flex-col p-6">
            <div className="flex flex-col items-center gap-3 rounded-xl bg-wash p-4">
              <span className="flex items-center gap-2 text-muted">
                <ReeAvatar size="sm" />
                +
                <ReeAvatar size="sm" color="lilac" />
                +
                <ReeAvatar size="sm" color="sage" />
              </span>
              <span className="text-[12px] font-semibold">{h.connect.caption}</span>
            </div>
            <span className="eyebrow mt-6">03 / CONNECT</span>
            <h3 className="mt-2 text-[17px] font-bold">{h.connect.title}</h3>
            <p className="mt-2 text-[13px] leading-relaxed text-muted">{h.connect.body}</p>
          </article>
        </div>
      </section>

      <section className="bg-bg">
        <div className="mx-auto max-w-[1200px] px-4 py-20 sm:px-6">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="eyebrow">LESS SETUP. MORE CONVERSATION.</p>
              <h2 className="mt-3 text-[30px] leading-tight font-extrabold sm:text-[38px]">
                {h.workflowTitle}
                <em className="text-blue not-italic">{h.workflowEm}</em>
              </h2>
            </div>
            <Link href={createHref} className="text-link text-[13px]">
              {h.start}
              <Icon name="arrow" />
            </Link>
          </div>
          <ol className="mt-10 grid gap-5 md:grid-cols-3">
            {([
              ['01', 'step1', 'ree'],
              ['02', 'step2', 'file'],
              ['03', 'step3', 'chat'],
            ] as const).map(([number, key, icon]) => (
              <li key={key} className="card p-6">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[12px] text-muted">{number}</span>
                  <Icon name={icon} className="size-5 text-blue" />
                </div>
                <h3 className="mt-6 text-[17px] font-bold">{h[key].title}</h3>
                <p className="mt-2 text-[13px] text-muted">{h[key].body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="mx-auto max-w-[1200px] px-4 py-20 sm:px-6">
        <p className="eyebrow">A COMPANION FOR EVERY CURIOSITY</p>
        <h2 className="mt-3 text-[30px] leading-tight font-extrabold sm:text-[38px]">
          {h.examplesTitle}
          <em className="text-blue not-italic">{h.examplesEm}</em>
        </h2>
        <p className="mt-3 text-[12px] text-muted">{h.examplesNote}</p>
        <div className="mt-10 grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <div className="grid gap-4">
            {([
              ['design', 'default'],
              ['code', 'slate'],
              ['read', 'sand'],
            ] as const).map(([key, color]) => (
              <article key={key} className="card flex items-start gap-4 p-5">
                <ReeAvatar color={color} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate text-[15px] font-bold">{h.examples[key].name}</h3>
                    <span className="tag">{h.example}</span>
                  </div>
                  <p className="mt-1 text-[13px] text-muted">{h.examples[key].body}</p>
                  <p className="mt-2 font-mono text-[13px]">
                    {h.examples[key].fee} <small className="text-muted">{h.perAnswer}</small>
                  </p>
                </div>
              </article>
            ))}
          </div>
          <figure className="relative flex aspect-video min-w-0 flex-col justify-end overflow-hidden rounded-2xl bg-gradient-to-br from-[#0b1a4a] via-ink to-[#123a7a] p-6 text-white">
            <span className="absolute top-1/2 left-1/2 inline-flex size-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-white/30 bg-white/10 backdrop-blur-sm" aria-hidden="true">
              <Icon name="play" className="size-7" />
            </span>
            <span className="absolute top-4 right-4 rounded-full bg-white/15 px-2.5 py-1 font-mono text-[11px]">0:15</span>
            <figcaption>
              <strong className="block text-[18px]">{h.videoTitle}</strong>
              <span className="mt-1 block text-[12px] text-white/70">{h.videoBody}</span>
              <span className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-white/15 px-2.5 py-1 text-[11px]">
                <Icon name="clock" className="size-3.5" />
                {h.videoSoon}
              </span>
            </figcaption>
          </figure>
        </div>
      </section>

      <section className="bg-ink text-white">
        <div className="mx-auto grid max-w-[1200px] items-center gap-10 px-4 py-20 sm:px-6 lg:grid-cols-[minmax(0,1fr)_420px]">
          <div>
            <p className="font-mono text-[10px] tracking-[0.18em] text-white/60">SIMPLE CREDITS. CLEAR VALUE.</p>
            <h2 className="mt-3 text-[30px] leading-tight font-extrabold sm:text-[38px]">
              {h.priceTitle1}
              <br />
              {h.priceTitle2}
            </h2>
            <p className="mt-4 text-[14px] leading-relaxed text-white/70">
              {h.priceBody1}
              <br />
              {h.priceBody2}
            </p>
            <Link href="/pricing" className="mt-8 inline-flex min-h-10 items-center gap-2 rounded-lg border border-white/30 px-4 text-[13px] font-semibold hover:bg-white/10">
              {h.priceCta}
              <Icon name="arrow" />
            </Link>
          </div>
          <div className="rounded-2xl border border-white/15 bg-white/5 p-6">
            <div className="flex items-center justify-between">
              <span className="font-mono text-[11px] tracking-[0.18em] text-white/60">PLAN</span>
              <span className="rounded-full bg-blue/30 px-2.5 py-0.5 text-[11px]">{h.monthly}</span>
            </div>
            <p className="mt-5">
              <strong className="text-[44px] font-extrabold">$10</strong> <span className="text-white/60">/ {h.perMonth}</span>
            </p>
            <p className="text-[17px] font-semibold">100,000 credits</p>
            <hr className="my-5 border-white/15" />
            <ul className="flex flex-col gap-2.5 text-[13px] text-white/80">
              {[h.planPerk1, h.planPerk2, h.planPerk3].map((perk) => (
                <li key={perk} className="flex items-center gap-2">
                  <Icon name="check" className="size-4 text-[#7fb6ff]" />
                  {perk}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section className="mx-auto grid max-w-[1200px] gap-10 px-4 py-20 sm:px-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <div>
          <p className="eyebrow">{t.site.faq.eyebrow}</p>
          <h2 className="mt-3 text-[30px] leading-tight font-extrabold sm:text-[38px]">
            {h.faqTitle1}
            <br />
            {h.faqTitle2}
          </h2>
        </div>
        <Faq t={t} to={4} />
      </section>

      <section className="mx-auto max-w-[1200px] px-4 pb-24 text-center sm:px-6">
        <p className="eyebrow">YOUR KNOWLEDGE. A NEW POSSIBILITY.</p>
        <h2 className="mt-3 text-[32px] leading-tight font-extrabold sm:text-[44px]">
          {h.finalTitle}
          <em className="text-blue not-italic">{h.finalEm}</em>
        </h2>
        <Link href={createHref} className="btn mt-8 min-h-12 px-6 text-[14px]">
          {h.ctaCreate}
          <Icon name="arrow" />
        </Link>
        <p className="mt-4 text-[12px] text-muted">{h.finalNote}</p>
      </section>
    </>
  );
}
