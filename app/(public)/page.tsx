import Link from 'next/link';
import { Button, SectionHeading, ShowcaseCard } from '@/components/ui/primitives';
import { DirectorySearch } from '@/components/site/directory-search';
import { HeroFigure } from '@/components/site/hero-figure';
import { LibraryTable } from '@/components/site/library-table';
import {
  ArrowRightIcon,
  ArrowUpRightIcon,
  CircleCheckIcon,
  ClockIcon,
  KeyIcon,
  PlusIcon,
  SparklesIcon,
} from '@/components/ui/icons';
import { listPublicLibraries, POPULARITY_WINDOW_DAYS } from '@/lib/application/libraries';
import { fill } from '@/lib/i18n/format';
import { translations } from '@/lib/i18n/server';

/**
 * The P0 home page (agent-first-proposal.md 13.1): the slogan, the directory
 * and a closing call to action. The channel directory, the four scenes and
 * the chat entry arrive with P1; until then the page claims only what the
 * product does today.
 */
export default async function HomePage() {
  const { t } = await translations();
  /* The featured table is the live catalogue's head, not copy. */
  const featured = (await listPublicLibraries({ sort: 'popular', limit: 6 })).map((row) => ({
    libraryId: row.publicId,
    title: row.title,
    domain: row.domainTag ?? row.publicId,
    trustScore: row.trustScore,
    chunks: row.totalChunks.toLocaleString('en-US'),
    updated: row.updatedAt ? new Date(row.updatedAt).toISOString().slice(0, 10) : '—',
  }));
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
        Knowledge directory -- a tinted zone with the catalogue floating paper
        white on it. This is where the page shows the real thing rather than
        describing it.
      */}
      <section className="wash-band">
        <div className="mx-auto w-full max-w-[1200px] px-5 py-20">
          <SectionHeading
            eyebrow={t.home.directoryEyebrow}
            title={t.home.directoryTitle}
            action={
              <Button href="/libraries/claim">
                <PlusIcon size={15} />
                {t.home.submitLibrary}
              </Button>
            }
          />

          <ShowcaseCard className="mt-10">
            <div className="flex flex-wrap items-center gap-3 pb-5">
              <DirectorySearch
                placeholder={t.home.searchPlaceholder}
                submitLabel={t.home.searchSubmit}
              />
              {/* The featured table is the popular head; both toggles open the
                  full directory in that order. */}
              <div className="flex shrink-0 items-center gap-1">
                <Link
                  href="/libraries?sort=popular"
                  className="flex h-10 items-center gap-2 rounded-full bg-brandsoft px-4 text-caption font-medium text-ink"
                >
                  <SparklesIcon size={15} />
                  {t.home.popular}
                </Link>
                <Link
                  href="/libraries?sort=recent"
                  className="flex h-10 items-center gap-2 rounded-full px-4 text-caption text-muted transition-colors hover:text-ink"
                >
                  <ClockIcon size={15} />
                  {t.home.recentlyUpdated}
                </Link>
              </div>
            </div>

            <LibraryTable entries={featured} />

            <div className="flex flex-wrap items-center justify-between gap-3 pt-5 text-caption">
              <p className="text-muted">
                {fill(t.home.sampleNote, { count: featured.length, days: POPULARITY_WINDOW_DAYS })}
              </p>
              <Link
                href="/libraries"
                className="flex items-center gap-1.5 text-brandink hover:underline"
              >
                {t.home.viewFullCatalog}
                <ArrowUpRightIcon size={14} />
              </Link>
            </div>
          </ShowcaseCard>
        </div>
      </section>

      {/* Closing call to action, on paper under a rule that parts it from the directory. */}
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
            <Button href="/libraries" size="md">
              {t.home.ctaBrowse}
              <ArrowRightIcon size={15} />
            </Button>
          </div>
        </div>
      </section>
    </>
  );
}
