import type { Metadata } from 'next';
import { cache } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Button, Card, Chip } from '@/components/ui/primitives';
import { publicClaimStatus } from '@/lib/application/claims';
import { POPULARITY_WINDOW_DAYS, publicLibraryDetail } from '@/lib/application/libraries';
import { API_KEY_PLACEHOLDER } from '@/lib/dashboard/snippets';
import type { Dictionary } from '@/lib/i18n/dictionary';
import { publicUrl } from '@/lib/site/origin';
import { fill } from '@/lib/i18n/format';
import { getMessages, translations } from '@/lib/i18n/server';

type Params = { params: Promise<{ libraryId: string[] }> };

/**
 * One read per request, not two.
 *
 * Next calls `generateMetadata` and the component for the same navigation,
 * and both need the whole detail. `publicLibraryDetail` is around eight
 * queries plus the refresh schedule, so an uncached pair
 * doubled all of it for every visit to a public library page. `cache()` is
 * per-request, so this shares the read within one render and never across
 * requests -- the same pattern `lib/http/dashboard.ts` uses for the workspace
 * usage overview, and it lives here rather than in the application layer so
 * that layer keeps no framework import.
 */
const libraryDetail = cache(publicLibraryDetail);

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const [{ libraryId }, t] = await Promise.all([params, getMessages()]);
  const entry = await libraryDetail(`/${libraryId.join('/')}`);
  if (!entry) return { title: t.library.fallbackTitle };
  return { title: entry.title, description: entry.description ?? undefined };
}

function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <Card className="flex flex-col gap-1 px-3.5 py-3">
      <span className="text-[9.5px] font-medium tracking-[0.04em] text-muted">{label}</span>
      <span className="text-[21px] leading-tight font-medium text-ink">{value}</span>
      <span className="text-[10.5px] text-faint">{note}</span>
    </Card>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1">
      <span className="shrink-0 text-[12px] text-muted">{k}</span>
      <span
        className={`min-w-0 text-right text-[12px] break-all text-ink ${
          mono ? 'font-mono text-[11px]' : 'font-medium'
        }`}
      >
        {v}
      </span>
    </div>
  );
}

function Panel({ title, right, children }: { title: string; right?: string; children: React.ReactNode }) {
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <h2 className="text-[13.5px] font-medium text-ink">{title}</h2>
        {right ? <span className="text-right text-[11.5px] text-faint">{right}</span> : null}
      </div>
      <div className="flex flex-col gap-2.5 p-4">{children}</div>
    </Card>
  );
}

/** `index_status` as the reader sees it; an unlisted value is shown as stored. */
function indexStatusLabel(
  status: string,
  labels: Dictionary['library']['detail']['indexStatus'],
): { text: string; tone: 'good' | 'warn' | 'neutral' } {
  const known = labels[status as keyof typeof labels];
  return {
    text: known ?? status,
    tone: status === 'ready' ? 'good' : status === 'failed' || status === 'stale' ? 'warn' : 'neutral',
  };
}

/** `0x1234…cdef` for a hash the row shows in a narrow column. */
function short(hash: string): string {
  return hash.length > 18 ? `${hash.slice(0, 10)}…${hash.slice(-6)}` : hash;
}

/**
 * A published library's public face, on the real rows: the routable predicate
 * decides existence (an invisible library 404s exactly like a missing one),
 * every figure comes from the pinned current version, and the panels read
 * what the tables hold -- the versions built, the scope the index obeyed,
 * where the refresh timer stands. Nothing is
 * shown that a row did not say (requirement.md 5.1, 6.4).
 */
export default async function LibraryDetailPage({ params }: Params) {
  const [{ libraryId }, { locale, t }] = await Promise.all([params, translations()]);
  const entry = await libraryDetail(`/${libraryId.join('/')}`);
  if (!entry) notFound();

  const l = t.library;
  const d = l.detail;
  const number = new Intl.NumberFormat(locale);
  const compact = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 });
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const when = (iso: string | null) => (iso ? dateTime.format(new Date(iso)) : d.never);
  const updated = entry.updatedAt ? date.format(new Date(entry.updatedAt)) : '—';
  const sizeMb = Math.max(1, Math.round(entry.storageBytes / 1_048_576));
  const pinnedId = `${entry.publicId}/${entry.version.label}`;
  const current = indexStatusLabel(entry.version.indexStatus, d.indexStatus);

  const restSample = [
    `curl "${publicUrl('/api/v1/context')}?libraryId=${encodeURIComponent(entry.publicId)}&query=how+do+I+get+started" \\`,
    /* The real prefix (`lib/dashboard/snippets.ts`, and `mm_live_`/`mm_test_`
       in architecture.md 5.1). `re0_...` is a format the server refuses
       outright, so a reader who pasted it and substituted their key would be
       told their key was malformed rather than that they had not filled it in. */
    `  -H "Authorization: Bearer ${API_KEY_PLACEHOLDER}"`,
  ].join('\n');
  const mcpSample = [
    'query-docs',
    `  libraryId: "${entry.publicId}"`,
    '  query:     "how do I get started"',
    '  maxTokens: 4000',
  ].join('\n');

  /* Only asked for once the library has an owner; an unowned one has no claim. */
  const claim = entry.claimedBy ? await publicClaimStatus(entry.publicId) : null;
  const claimedAt = claim?.claimedAt ? date.format(claim.claimedAt) : null;

  return (
    <section className="mx-auto w-full max-w-[1080px] px-5 pt-7 pb-14">
      <nav className="flex items-center gap-2 text-[12px] text-muted">
        <Link href="/libraries" className="hover:text-ink">
          {l.breadcrumb}
        </Link>
        <span aria-hidden className="text-line">/</span>
        {entry.domainTag ? (
          <>
            <span>{entry.domainTag}</span>
            <span aria-hidden className="text-line">/</span>
          </>
        ) : null}
        <span className="font-medium text-ink">{entry.title}</span>
      </nav>

      <div className="mt-5 flex flex-wrap items-start justify-between gap-6">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-[28px] leading-tight font-medium text-ink">
              {entry.title}
            </h1>
            <Chip tone="brand">{l.public}</Chip>
            {entry.claimedBy ? (
              <Chip tone="good">{l.claimed}</Chip>
            ) : (
              <Chip tone="warn">{l.unclaimed}</Chip>
            )}
          </div>

          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <code className="rounded-md border border-line bg-subtle px-2.5 py-1 font-mono text-[12px] text-steel">
              {entry.publicId}
            </code>
            <span className="text-[12px] text-faint">
              {l.pinnedVersion}
              {pinnedId}
            </span>
          </div>

          {entry.description ? (
            <p className="mt-3 max-w-[70ch] text-[13.5px] leading-[1.7] text-muted">
              {entry.description}
            </p>
          ) : null}

          <div className="mt-3.5 flex flex-wrap gap-2">
            {entry.domainTag ? <Chip>{entry.domainTag}</Chip> : null}
            {entry.language ? <Chip>{entry.language}</Chip> : null}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <Button href={`/playground?library=${encodeURIComponent(entry.publicId)}`}>
            {l.tryInPlayground}
          </Button>
        </div>
      </div>

      <div className="mt-7 grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Stat
          label={l.stats.trust}
          value={String(entry.trustScore)}
          note={
            entry.scoredAt
              ? fill(d.scoredAt, { when: date.format(new Date(entry.scoredAt)) })
              : d.scoredNever
          }
        />
        <Stat
          label={l.stats.benchmark}
          value={String(entry.benchmarkScore)}
          note={l.stats.benchmarkNote}
        />
        <Stat
          label={l.stats.chunks}
          value={number.format(entry.version.totalChunks)}
          note={fill(l.stats.chunksNote, { count: entry.version.documents })}
        />
        <Stat
          label={l.stats.tokens}
          value={compact.format(entry.version.totalTokens)}
          note={l.stats.tokensNote}
        />
        <Stat label={l.stats.size} value={`${sizeMb} MB`} note={l.stats.sizeNote} />
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-[1fr_312px]">
        <div className="flex flex-col gap-4">
          <Panel title={l.versionPanel} right={l.versionPanelRight}>
            <div className="rounded-lg border border-line bg-subtle p-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[14px] font-medium text-ink">
                    {entry.version.label}
                  </span>
                  <Chip tone="brand">{l.currentVersion}</Chip>
                  <Chip tone={current.tone}>{current.text}</Chip>
                </div>
                <span className="text-[11.5px] text-faint">
                  {fill(l.publishedAt, {
                    when: entry.version.publishedAt
                      ? date.format(new Date(entry.version.publishedAt))
                      : updated,
                  })}
                </span>
              </div>
              <div className="mt-2.5 flex flex-col">
                <Row
                  k="Parser / Chunker"
                  v={`${entry.version.parserVersion} · ${entry.version.chunkerVersion}`}
                />
                <Row k="Embedding Model" v={entry.version.embeddingModel} />
              </div>
            </div>
            <p className="text-[11.5px] leading-[1.7] text-faint">{l.versionNote}</p>
          </Panel>

          <Panel
            title={d.historyPanel}
            right={fill(d.historyPanelRight, { count: entry.versions.length })}
          >
            {entry.versions.length === 0 ? (
              <p className="text-[12px] text-muted">{d.historyEmpty}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] text-[12px]">
                  <thead>
                    <tr className="text-left text-[10px] font-medium tracking-[0.04em] text-muted">
                      <th className="py-1.5 pr-3 font-medium">{d.historyColumns.version}</th>
                      <th className="py-1.5 pr-3 font-medium">{d.historyColumns.status}</th>
                      <th className="py-1.5 pr-3 text-right font-medium">{d.historyColumns.chunks}</th>
                      <th className="py-1.5 pr-3 text-right font-medium">{d.historyColumns.tokens}</th>
                      <th className="py-1.5 text-right font-medium">{d.historyColumns.built}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entry.versions.map((version) => {
                      const status = indexStatusLabel(version.indexStatus, d.indexStatus);
                      return (
                        <tr key={version.label} className="border-t border-line/70">
                          <td className="py-2 pr-3 font-mono text-[11.5px] text-ink">
                            {version.label}
                            {version.current ? (
                              <span className="ml-2 align-middle">
                                <Chip tone="brand">{l.currentVersion}</Chip>
                              </span>
                            ) : null}
                          </td>
                          <td className="py-2 pr-3">
                            <Chip tone={status.tone}>{status.text}</Chip>
                          </td>
                          <td className="py-2 pr-3 text-right text-steel">
                            {number.format(version.totalChunks)}
                          </td>
                          <td className="py-2 pr-3 text-right text-steel">
                            {compact.format(version.totalTokens)}
                          </td>
                          <td className="py-2 text-right text-muted">
                            {date.format(new Date(version.publishedAt ?? version.createdAt))}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <Panel title={l.examplesPanel} right={l.examplesPanelRight}>
            <p className="text-[10.5px] font-medium tracking-[0.04em] text-muted">{d.restPanel}</p>
            <div className="rounded-lg border border-line bg-subtle p-3.5">
              <pre className="overflow-x-auto font-mono text-[11px] leading-[1.75] text-good">
                {restSample}
              </pre>
            </div>
            <p className="text-[10.5px] font-medium tracking-[0.04em] text-muted">{d.mcpPanel}</p>
            <div className="rounded-lg border border-line bg-subtle p-3.5">
              <pre className="overflow-x-auto font-mono text-[11px] leading-[1.75] text-good">
                {mcpSample}
              </pre>
            </div>
            <p className="text-[11.5px] leading-[1.7] text-faint">
              {fill(d.codeNote, { pinned: pinnedId })} {l.examplesNote}
            </p>
          </Panel>
        </div>

        <div className="flex flex-col gap-4">
          <Panel title={l.sourcePanel}>
            {entry.sources.map((source) => (
              <div key={`${source.type}-${source.location}`} className="flex items-center gap-2">
                <Chip>{source.type}</Chip>
                <span className="truncate font-mono text-[11.5px] text-steel" title={source.location}>
                  {source.location}
                </span>
              </div>
            ))}
            <Row k={l.lastSync} v={updated} />
            <Row
              k={fill(d.recentCalls, { days: POPULARITY_WINDOW_DAYS })}
              v={number.format(entry.recentCalls)}
            />
          </Panel>

          <Panel title={d.scopePanel}>
            <Row
              k="folders"
              v={entry.scope.folders.length > 0 ? entry.scope.folders.join(', ') : d.scopeAll}
              mono
            />
            <Row
              k="excludeFolders"
              v={
                entry.scope.excludeFolders.length > 0
                  ? entry.scope.excludeFolders.join(', ')
                  : d.scopeNone
              }
              mono
            />
            <p className="text-[11px] leading-[1.65] text-faint">{d.scopeNote}</p>
          </Panel>

          <Panel title={d.freshnessPanel}>
            <div className="flex items-center gap-2">
              <Chip>{d.policy[entry.freshness.refreshPolicy]}</Chip>
              {entry.freshness.refreshOpen ? <Chip tone="brand">{d.refreshOpen}</Chip> : null}
            </div>
            <Row k={d.lastChecked} v={when(entry.freshness.lastCheckedAt)} />
            <Row k={d.lastRefreshed} v={when(entry.freshness.lastSuccessfulRefreshAt)} />
            <Row
              k={d.nextDue}
              v={entry.freshness.nextDueAt ? when(entry.freshness.nextDueAt) : d.nextDueNone}
            />
          </Panel>


          <Panel title={l.ownershipPanel}>
            {entry.claimedBy ? (
              <>
                <div className="flex items-center gap-2">
                  <Chip tone="good">{l.claimed}</Chip>
                  <span className="text-[12px] font-medium text-ink">{entry.claimedBy}</span>
                </div>
                {/*
                  requirement.md 5.1: when ownership came from a verified claim,
                  the date it was proved is part of what makes the badge worth
                  reading. An owner by creation has no such date and gets none
                  invented for them.
                */}
                {claimedAt ? (
                  <p className="text-[11px] leading-[1.65] text-faint">
                    {fill(l.claimStatus.claimedAt, { when: claimedAt })} ·{' '}
                    {l.claimStatus.claimedByVerification}
                  </p>
                ) : null}
              </>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <Chip tone="warn">{l.unclaimed}</Chip>
                  <span className="text-[12px] text-muted">{l.noOwner}</span>
                </div>
                <p className="text-[11px] leading-[1.65] text-faint">{l.claimNote}</p>
                {/* The claim page needs to know which library; the link says so. */}
                <Button
                  href={`/libraries/claim?library=${encodeURIComponent(entry.publicId)}`}
                  className="mt-1 w-full"
                >
                  {l.claimCta}
                </Button>
              </>
            )}
          </Panel>
        </div>
      </div>
    </section>
  );
}
