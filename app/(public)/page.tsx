import Link from 'next/link';
import { Button, SectionHeading, ShowcaseCard } from '@/components/ui/primitives';
import { ClaudeIcon, CodexIcon, CursorIcon, McpIcon } from '@/components/ui/brand-icons';
import { DirectorySearch } from '@/components/site/directory-search';
import { HeroFigure } from '@/components/site/hero-figure';
import { LibraryTable } from '@/components/site/library-table';
import { ConnectTabs } from '@/components/site/connect-tabs';
import {
  ArrowRightIcon,
  ArrowUpRightIcon,
  BracesIcon,
  CircleCheckIcon,
  ClockIcon,
  GlobeIcon,
  KeyIcon,
  MessagesSquareIcon,
  PlusIcon,
  SparklesIcon,
} from '@/components/ui/icons';
import { listPublicLibraries, POPULARITY_WINDOW_DAYS } from '@/lib/application/libraries';
import { embedSnippet } from '@/lib/domain/site-key';
import { publicUrl } from '@/lib/site/origin';
import { fill } from '@/lib/i18n/format';
import { getMessages } from '@/lib/i18n/server';

/** Vendor logomarks where the surface has one; the design source's glyph otherwise. */
const SURFACES = [
  { label: 'Claude', Icon: ClaudeIcon },
  { label: 'Codex', Icon: CodexIcon },
  { label: 'Cursor', Icon: CursorIcon },
  { label: 'REST API', Icon: BracesIcon },
  { label: 'MCP', Icon: McpIcon },
];

export default async function HomePage() {
  const t = await getMessages();
  /* The MCP endpoint a person pastes into their client: the one thing every
     surface in the hero row shares. It is always the public host -- a visitor
     reading a preview deployment still has to connect to the real one.
     Anonymous use rides the trial limit; an API key from the dashboard lifts
     it (requirement.md 9.3). */
  const mcpUrl = publicUrl('/mcp');
  /* The widget's one line, with a placeholder where the site key goes. */
  const widgetSnippet = embedSnippet(publicUrl('/widget.js'), 'mm_site_…');
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
        <div className="mx-auto grid w-full max-w-[1200px] grid-cols-1 items-center gap-12 px-5 pt-20 pb-16 lg:grid-cols-[minmax(0,1fr)_400px]">
          <div className="flex flex-col items-center text-center lg:items-start lg:text-left">
          <p className="eyebrow">{t.home.badge}</p>

          <h1 className="mt-5 max-w-[18ch] text-[40px] leading-[1.25] font-semibold tracking-[0.018em] text-ink sm:text-[56px]">
            {t.home.title}
          </h1>

          <p className="mt-5 max-w-[60ch] text-subheading text-muted">{t.home.lede}</p>

          <div className="mt-8 flex flex-wrap items-center justify-center gap-3 lg:justify-start">
            <Button href="/login" size="md">
              <KeyIcon />
              {t.home.getKey}
            </Button>
            <Button href="/playground" variant="outline" size="md">
              <SparklesIcon size={16} />
              {t.home.cli.tryOnline}
            </Button>
          </div>

          {/* Three ways in, ordered by how little the reader has to know: hand
              the prompt to the model they are already talking to, paste the
              endpoint themselves, or run the CLI (packages/cli), which writes
              the same entry into every client on the machine. */}
          <div className="mt-10 w-full">
            <ConnectTabs
              options={[
                {
                  id: 'prompt',
                  label: t.home.connect.promptTab,
                  value: fill(t.home.connect.prompt, { url: mcpUrl }),
                  copyLabel: t.home.connect.promptCopy,
                  copiedLabel: t.home.installCopied,
                  note: t.home.connect.promptNote,
                },
                {
                  id: 'mcp',
                  label: t.home.connect.mcpTab,
                  value: mcpUrl,
                  copyLabel: t.home.install,
                  copiedLabel: t.home.installCopied,
                  note: t.home.connect.mcpNote,
                  mono: true,
                },
                {
                  id: 'cli',
                  label: t.home.connect.cliTab,
                  value: t.home.cli.command,
                  copyLabel: t.home.cli.copy,
                  copiedLabel: t.home.cli.copied,
                  note: t.home.cli.note,
                  mono: true,
                },
              ]}
            />
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

      {/* The centred logo row that closes the hero. */}
      <section>
        <div className="mx-auto w-full max-w-[1200px] px-5 pb-20">
          <p className="text-center text-caption text-muted">{t.home.surfacesNote}</p>
          <ul className="mt-8 flex flex-wrap items-center justify-center gap-x-14 gap-y-6">
            {SURFACES.map(({ label, Icon }) => (
              <li key={label} className="flex items-center gap-2 text-body text-ink">
                <Icon size={20} />
                {label}
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/*
        Knowledge directory -- a tinted zone with the product floating paper
        white on it. This is where the system shows the real thing rather than
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
                submitLabel={t.home.cli.searchSubmit}
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


      {/*
        Website widget -- the library, turned round to face the owner's own
        visitors (requirement.md 9.4). The copy says what it does; the card
        shows the whole integration and what a visitor sees.
      */}
      <section>
        <div className="mx-auto grid w-full max-w-[1200px] grid-cols-1 items-center gap-12 px-5 py-20 lg:grid-cols-[minmax(0,1fr)_460px]">
          <div className="flex flex-col items-start">
            <span className="eyebrow">{t.home.widget.eyebrow}</span>
            <h2 className="mt-4 max-w-[22ch] text-heading-sm font-semibold tracking-[0.018em] text-ink">
              {t.home.widget.title}
            </h2>
            <p className="mt-4 max-w-[58ch] text-subheading text-muted">{t.home.widget.lede}</p>
            <ul className="mt-6 flex flex-col gap-2.5 text-body text-ink">
              {t.home.widget.points.map((point) => (
                <li key={point} className="flex items-start gap-2.5">
                  <CircleCheckIcon size={16} className="mt-[3px] shrink-0 text-brandink" />
                  {point}
                </li>
              ))}
            </ul>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Button href="/dashboard/libraries" size="md">
                <MessagesSquareIcon size={16} />
                {t.home.widget.cta}
              </Button>
              <span className="text-caption text-muted">{t.home.widget.planNote}</span>
            </div>
          </div>

          <ShowcaseCard>
            <p className="text-caption font-medium text-muted">{t.home.widget.snippetLabel}</p>
            <pre className="mt-2 overflow-x-auto rounded-md border border-line bg-subtle px-3.5 py-3 font-mono text-[12px] leading-[1.6] text-ink">
              <code>{widgetSnippet}</code>
            </pre>
            <p className="mt-2 text-caption text-muted">{t.home.widget.snippetNote}</p>

            {/* A still of the widget itself: what the visitor sees after the
                line above. Markup only -- the real one lives in public/. */}
            <div
              aria-hidden
              className="mt-6 overflow-hidden rounded-xl border border-line bg-card shadow-[0_12px_32px_rgba(15,23,42,0.08)]"
            >
              <div className="flex items-center justify-between bg-brand px-4 py-3 text-white">
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-semibold">{t.home.widget.demoTitle}</p>
                  <p className="text-[11px] opacity-85">{t.home.widget.demoSubtitle}</p>
                </div>
                <span className="flex size-7 items-center justify-center rounded-md bg-white/20 text-[12px]">
                  ✕
                </span>
              </div>
              <div className="flex flex-col gap-2.5 bg-subtle px-4 py-4 text-[12.5px] leading-[1.5]">
                <p className="max-w-[85%] self-end rounded-xl rounded-br-[4px] bg-brand px-3 py-2 text-white">
                  {t.home.widget.demoQuestion}
                </p>
                <div className="max-w-[92%] self-start rounded-xl rounded-bl-[4px] border border-line bg-card px-3 py-2 text-ink">
                  <p>
                    {t.home.widget.demoAnswer}
                    <sup className="ml-0.5 text-[9.5px] text-brandink">[1]</sup>
                  </p>
                  <div className="mt-2.5 border-t border-line pt-2">
                    <p className="text-[10.5px] font-semibold tracking-[0.03em] text-muted uppercase">
                      {t.home.widget.demoSources}
                    </p>
                    <div className="mt-1.5 flex items-center justify-between gap-2 rounded-md border border-line bg-card px-2.5 py-1.5">
                      <span className="truncate text-[12px] font-medium">[1] {t.home.widget.demoSource}</span>
                      <span className="shrink-0 text-[11px] font-semibold text-brandink">{t.home.widget.demoOpen}</span>
                    </div>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 border-t border-line px-4 py-3">
                <span className="flex h-9 flex-1 items-center rounded-lg border border-line px-3 text-[12px] text-muted">
                  {t.home.widget.demoPlaceholder}
                </span>
                <span className="flex h-9 items-center rounded-lg bg-brand px-3.5 text-[12px] font-semibold text-white">
                  {t.embed.send}
                </span>
              </div>
            </div>
          </ShowcaseCard>
        </div>
      </section>

      {/*
        Shared page -- the library as a page of its own (lib/domain/showcase.ts),
        mirrored so the page's still sits on the left and the copy on the
        right, the way the widget above runs copy first.
      */}
      <section className="wash-band">
        <div className="mx-auto grid w-full max-w-[1200px] grid-cols-1 items-center gap-12 px-5 py-20 lg:grid-cols-[460px_minmax(0,1fr)]">
          {/* A still of a published page: the introduction and the ask box
              under it. Markup only -- the real one is app/s/. */}
          <ShowcaseCard className="order-2 lg:order-1">
            <div aria-hidden className="overflow-hidden rounded-xl border border-line bg-card">
              <div className="flex items-start gap-3 px-5 pt-5 pb-4">
                <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-brand text-[15px] font-semibold text-white">
                  {t.home.showcase.demoName.slice(0, 1)}
                </span>
                <div className="min-w-0">
                  <p className="text-[10px] font-medium tracking-[0.08em] text-brandink uppercase">
                    {t.home.showcase.demoKind}
                  </p>
                  <p className="mt-0.5 truncate text-[15px] font-semibold text-ink">{t.home.showcase.demoName}</p>
                  <p className="text-[12px] text-muted">{t.home.showcase.demoTagline}</p>
                </div>
              </div>
              <ul className="flex flex-wrap gap-1.5 px-5 pb-4">
                {t.home.showcase.demoFacts.map((fact) => (
                  <li key={fact} className="rounded-full border border-line bg-subtle px-2.5 py-1 text-[11px] text-steel">
                    {fact}
                  </li>
                ))}
              </ul>
              <div className="border-t border-line bg-subtle px-5 py-4">
                <p className="text-[13px] font-semibold text-ink">{t.home.showcase.demoAsk}</p>
                <p className="mt-1 text-[11px] leading-[1.5] text-muted">{t.home.showcase.demoAskHint}</p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {t.home.showcase.demoQuestions.map((question) => (
                    <span key={question} className="rounded-full border border-line bg-card px-2.5 py-1 text-[11px] text-ink">
                      {question}
                    </span>
                  ))}
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <span className="flex h-9 flex-1 items-center rounded-lg border border-line bg-card px-3 text-[12px] text-muted">
                    {t.home.showcase.demoPlaceholder}
                  </span>
                  <span className="flex h-9 items-center rounded-lg bg-brand px-3.5 text-[12px] font-semibold text-white">
                    {t.showcase.send}
                  </span>
                </div>
              </div>
            </div>
          </ShowcaseCard>

          <div className="order-1 flex flex-col items-start lg:order-2">
            <span className="eyebrow">{t.home.showcase.eyebrow}</span>
            <h2 className="mt-4 max-w-[22ch] text-heading-sm font-semibold tracking-[0.018em] text-ink">
              {t.home.showcase.title}
            </h2>
            <p className="mt-4 max-w-[58ch] text-subheading text-muted">{t.home.showcase.lede}</p>
            <ul className="mt-6 flex flex-col gap-2.5 text-body text-ink">
              {t.home.showcase.points.map((point) => (
                <li key={point} className="flex items-start gap-2.5">
                  <CircleCheckIcon size={16} className="mt-[3px] shrink-0 text-brandink" />
                  {point}
                </li>
              ))}
            </ul>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Button href="/dashboard/showcases" size="md">
                <GlobeIcon size={16} />
                {t.home.showcase.cta}
              </Button>
              <span className="text-caption text-muted">{t.home.showcase.planNote}</span>
            </div>
          </div>
        </div>
      </section>

      {/* Closing call to action, back on the paper canvas. */}
      <section>
        <div className="mx-auto flex w-full max-w-[1200px] flex-col items-start justify-between gap-8 px-5 py-20 sm:flex-row sm:items-center">
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
