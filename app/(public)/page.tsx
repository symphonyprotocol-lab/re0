import Link from 'next/link';
import { Button, SectionHeading, ShowcaseCard } from '@/components/ui/primitives';
import { HeroFigure } from '@/components/site/hero-figure';
import { ChannelGrid } from '@/components/site/channel-grid';
import { CopyButton } from '@/components/dashboard/copy-button';
import {
  ArrowRightIcon,
  ArrowUpRightIcon,
  BotIcon,
  CircleCheckIcon,
  ClockIcon,
  KeyIcon,
  PlusIcon,
  SparklesIcon,
} from '@/components/ui/icons';
import { cachedChannelDirectory } from '@/lib/http/channel-directory';
import { isDirectorySort, type DirectorySort } from '@/lib/domain/channel';
import { translations } from '@/lib/i18n/server';
import { publicUrl } from '@/lib/site/origin';

/** The directory block shows one row of cards; the full directory has the rest. */
const FEATURED = 6;

/**
 * The P1 home page (agent-first-proposal.md 4.2, 13.1): the slogan, the
 * channel directory, and the address agent developers start from. The chat
 * input and the four scene demos need the P2 agent and arrive with it; the
 * page claims only what the product does today.
 */
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ t, locale }, query] = await Promise.all([translations(), searchParams]);
  const sort: DirectorySort = isDirectorySort(query.sort) ? query.sort : 'hot';
  const { entries } = await cachedChannelDirectory(sort, FEATURED, 0);
  const platformCard = publicUrl('/.well-known/agent-card.json');

  return (
    <>
      {/*
        Hero -- a split composition on the paper canvas: the copy and the
        action cluster on the left, the figure on the right. It centres again
        below the split's breakpoint, where there is no second column for the
        text to sit beside.
      */}
      <section>
        <div className="mx-auto grid w-full max-w-[1200px] grid-cols-1 items-center gap-12 px-5 pt-20 pb-20 lg:grid-cols-[minmax(0,1fr)_400px]">
          <div className="flex flex-col items-center text-center lg:items-start lg:text-left">
            <p className="eyebrow">{t.home.badge}</p>

            <h1 className="mt-5 max-w-[18ch] text-[40px] leading-[1.25] font-semibold tracking-[0.018em] text-ink sm:text-[56px]">
              {t.home.title}
            </h1>

            <p className="mt-5 max-w-[60ch] text-subheading text-muted">{t.home.lede}</p>

            <div className="mt-8 flex flex-wrap items-center justify-center gap-3 lg:justify-start">
              <Button href="/login" size="md">
                <KeyIcon />
                {t.nav.signIn}
              </Button>
              <Button href="/playground" variant="outline" size="md">
                <SparklesIcon size={16} />
                {t.home.tryOnline}
              </Button>
            </div>

            <ul className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-caption text-muted lg:justify-start">
              {t.home.heroPoints.map((p) => (
                <li key={p} className="flex items-center gap-2">
                  <CircleCheckIcon size={14} className="text-brandink" />
                  {p}
                </li>
              ))}
            </ul>
          </div>

          <HeroFigure className="mx-auto hidden w-full max-w-[400px] lg:block" />
        </div>
      </section>

      {/*
        Channel directory -- a tinted zone with the live directory's head on
        paper white. This is where the page shows the real thing rather than
        describing it.
      */}
      <section className="wash-band">
        <div className="mx-auto w-full max-w-[1200px] px-5 py-20">
          <SectionHeading
            eyebrow={t.home.directoryEyebrow}
            title={t.home.directoryTitle}
            action={
              <Button href="/dashboard/channels">
                <PlusIcon size={15} />
                {t.home.openChannel}
              </Button>
            }
          />

          <ShowcaseCard className="mt-10">
            <div className="flex flex-wrap items-center gap-1 pb-5">
              <Link
                href="/?sort=hot"
                scroll={false}
                className={`flex h-10 items-center gap-2 rounded-full px-4 text-caption ${
                  sort === 'hot' ? 'bg-brandsoft font-medium text-ink' : 'text-muted transition-colors hover:text-ink'
                }`}
              >
                <SparklesIcon size={15} />
                {t.home.popular}
              </Link>
              <Link
                href="/?sort=recent"
                scroll={false}
                className={`flex h-10 items-center gap-2 rounded-full px-4 text-caption ${
                  sort === 'recent' ? 'bg-brandsoft font-medium text-ink' : 'text-muted transition-colors hover:text-ink'
                }`}
              >
                <ClockIcon size={15} />
                {t.home.recentlyUpdated}
              </Link>
            </div>

            {entries.length > 0 ? (
              <ChannelGrid entries={entries} locale={locale} />
            ) : (
              <p className="rounded-md border border-dashed border-line px-5 py-10 text-center text-caption text-muted">
                {t.home.directoryEmpty}
              </p>
            )}

            <div className="flex justify-end pt-5 text-caption">
              <Link
                href={sort === 'recent' ? '/channels?sort=recent' : '/channels'}
                className="flex items-center gap-1.5 text-brandink hover:underline"
              >
                {t.home.viewFullCatalog}
                <ArrowUpRightIcon size={14} />
              </Link>
            </div>
          </ShowcaseCard>
        </div>
      </section>

      {/* For agent developers: the platform card is where an agent starts (proposal 7.1). */}
      <section id="agents" className="mx-auto w-full max-w-[1200px] scroll-mt-24 px-5 py-20">
        <div className="grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="flex flex-col gap-4">
            <p className="eyebrow">{t.home.agentsEyebrow}</p>
            <h2 className="text-heading-sm font-semibold tracking-[0.018em] text-ink">{t.home.agentsTitle}</h2>
            <p className="max-w-[60ch] text-body text-muted">{t.home.agentsBody}</p>
            <ul className="flex flex-col gap-2 text-caption text-steel">
              {t.home.agentsPoints.map((point) => (
                <li key={point} className="flex items-start gap-2">
                  <CircleCheckIcon size={14} className="mt-[3px] shrink-0 text-brandink" />
                  {point}
                </li>
              ))}
            </ul>
          </div>
          <ShowcaseCard className="flex flex-col gap-4 self-start">
            <span className="flex items-center gap-2 text-caption font-medium text-ink">
              <BotIcon size={16} className="text-brandink" />
              {t.home.agentsCardLabel}
            </span>
            <span className="flex items-center gap-2 rounded-md border border-line bg-subtle py-1 pr-1 pl-3">
              <code className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink">{platformCard}</code>
              <CopyButton value={platformCard} label={t.home.agentsCardLabel} className="text-steel hover:bg-card" />
            </span>
            <div className="flex flex-wrap gap-3">
              <Button href="/.well-known/agent-card.json" variant="outline">
                {t.home.agentsCardLabel}
                <ArrowUpRightIcon size={14} />
              </Button>
              <Button href="/dashboard/api-keys" variant="outline">
                <KeyIcon size={15} />
                {t.home.agentsKeys}
              </Button>
            </div>
          </ShowcaseCard>
        </div>
      </section>

      {/* Closing call to action, on paper under a rule that parts it from the section above. */}
      <section className="mx-auto w-full max-w-[1200px] px-5">
        <div className="flex w-full flex-col items-start justify-between gap-8 border-t border-line py-20 sm:flex-row sm:items-center">
          <div className="flex flex-col gap-2">
            <span className="eyebrow">{t.home.ctaEyebrow}</span>
            <h2 className="max-w-[22ch] text-heading-sm font-semibold tracking-[0.018em] text-ink">
              {t.home.ctaTitle}
            </h2>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button href="/pricing" variant="outline" size="md">
              {t.home.ctaPricing}
            </Button>
            <Button href="/channels" size="md">
              {t.home.ctaBrowse}
              <ArrowRightIcon size={15} />
            </Button>
          </div>
        </div>
      </section>
    </>
  );
}
