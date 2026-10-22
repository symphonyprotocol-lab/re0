import type { Metadata } from 'next';
import Link from 'next/link';
import { Button, SectionHeading } from '@/components/ui/primitives';
import { LibraryTable, type LibraryTableEntry } from '@/components/site/library-table';
import {
  CATALOG_PAGE_SIZE,
  countPublicLibraries,
  listPublicLibraries,
  POPULARITY_WINDOW_DAYS,
} from '@/lib/application/libraries';
import { groupNestedIds, parentPublicId } from '@/lib/domain/library';
import { resolveLibrary } from '@/lib/application/retrieval/resolve-library';
import { fill } from '@/lib/i18n/format';
import { getMessages, translations } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const { catalog: c } = await getMessages();
  return { title: c.metaTitle, description: c.metaDescription };
}

type Search = { searchParams: Promise<{ q?: string; sort?: string; page?: string }> };

/** `/libraries?sort=…&q=…&page=…`, with the defaults left off. */
function directoryHref(input: { sort: 'popular' | 'recent'; query: string; page: number }): string {
  const params = new URLSearchParams();
  if (input.sort === 'recent') params.set('sort', 'recent');
  if (input.query) params.set('q', input.query);
  if (input.page > 1) params.set('page', String(input.page));
  const qs = params.toString();
  return qs ? `/libraries?${qs}` : '/libraries';
}

/**
 * The public directory, on the real rows. Browsing lists routable libraries
 * (the same predicate retrieval admits); a search query runs the same
 * content-based resolve the MCP tool uses (architecture.md 9.6), so what the
 * directory finds is exactly what an agent would find. Server-side and
 * unmetered: resolve never counts a Call.
 *
 * Both branches fill the same table, so both have to fill every column of it
 * from a real row.
 */
export default async function CatalogPage({ searchParams }: Search) {
  const [{ q, sort, page: pageParam }, { locale, t }] = await Promise.all([
    searchParams,
    translations(),
  ]);
  const c = t.catalog;

  const query = (q ?? '').trim().slice(0, 200);
  const recent = sort === 'recent';
  const order = recent ? 'recent' : 'popular';
  const number = new Intl.NumberFormat(locale);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });

  /* The count is the directory's, not the search's: a search is one page of
     the resolver's ranked matches and is not paged. */
  const totalCount = await countPublicLibraries();
  const pages = Math.max(1, Math.ceil(totalCount / CATALOG_PAGE_SIZE));
  const requested = Number.parseInt(pageParam ?? '1', 10);
  const page = Number.isFinite(requested) ? Math.min(Math.max(1, requested), pages) : 1;

  let entries: LibraryTableEntry[];
  if (query) {
    const resolved = await resolveLibrary(
      { workspaceId: null, apiKeyId: null, requestId: crypto.randomUUID(), anonymous: true },
      { query },
    );
    entries = resolved.results.map((candidate) => ({
      libraryId: candidate.libraryId,
      title: candidate.title,
      domain: candidate.description ?? candidate.libraryId,
      trustScore: candidate.trustScore,
      chunks: number.format(candidate.chunks),
      updated: date.format(new Date(candidate.updatedAt)),
    }));
  } else {
    const rows = await listPublicLibraries({
      sort: order,
      limit: CATALOG_PAGE_SIZE,
      offset: (page - 1) * CATALOG_PAGE_SIZE,
    });
    /*
     * Nested libraries follow the library they sit under (requirement.md 6.1:
     * `/websites/ethereum/whitepaper` groups under `/websites/ethereum`), in
     * the sort's own order otherwise. A search result is ranked by relevance
     * and is left alone.
     */
    const present = new Set(rows.map((row) => row.publicId));
    entries = groupNestedIds(rows, (row) => row.publicId).map((row) => {
      const parent = parentPublicId(row.publicId);
      return {
        libraryId: row.publicId,
        title: row.title,
        domain: row.domainTag ?? row.publicId,
        trustScore: row.trustScore,
        chunks: number.format(row.totalChunks),
        updated: row.updatedAt ? date.format(new Date(row.updatedAt)) : '—',
        nestedUnder: parent !== null && present.has(parent) ? parent : null,
      };
    });
  }

  const total = number.format(totalCount);
  const first = query ? (entries.length > 0 ? 1 : 0) : (page - 1) * CATALOG_PAGE_SIZE + 1;
  const last = query ? entries.length : Math.min(totalCount, page * CATALOG_PAGE_SIZE);

  return (
    <section className="mx-auto w-full max-w-[1200px] px-5 pt-11 pb-16">
      <SectionHeading
        eyebrow="KNOWLEDGE DIRECTORY"
        title={c.title}
        action={
          <div className="flex flex-wrap gap-2.5">
            <Button href="/libraries/claim" variant="outline">
              {c.claim}
            </Button>
            <Button href="/libraries/claim">{c.submit}</Button>
          </div>
        }
      />

      <p className="mt-4 max-w-[80ch] text-[13px] leading-[1.7] text-muted">{c.lede}</p>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <form
          method="get"
          className="flex h-[46px] min-w-0 flex-1 items-center gap-2.5 rounded-lg border border-line bg-card px-4 shadow-md"
        >
          <span aria-hidden className="text-muted">
            ⌕
          </span>
          <input
            name="q"
            defaultValue={query}
            placeholder={c.searchPlaceholder}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-muted/70"
          />
          {recent ? <input type="hidden" name="sort" value="recent" /> : null}
          <button
            type="submit"
            className="rounded border border-line bg-mutedbg px-1.5 py-0.5 text-[11px] text-muted"
          >
            ⏎
          </button>
        </form>
        <div className="flex h-[46px] items-center gap-1 rounded-lg border border-line bg-card p-1">
          <Link
            href={directoryHref({ sort: 'popular', query, page: 1 })}
            className={`rounded-md px-3 py-1.5 text-[12px] font-medium ${
              recent ? 'text-muted' : 'bg-brandsoft text-brandink'
            }`}
          >
            {c.popular}
          </Link>
          <Link
            href={directoryHref({ sort: 'recent', query, page: 1 })}
            className={`rounded-md px-3 py-1.5 text-[12px] font-medium ${
              recent ? 'bg-brandsoft text-brandink' : 'text-muted'
            }`}
          >
            {c.recentlyUpdated}
          </Link>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-[12px]">
        <p className="text-muted">
          {query
            ? fill(c.directory.searchResults, { query })
            : fill(c.totalLine, {
                total,
                sort: recent
                  ? c.directory.sortedRecent
                  : fill(c.directory.sortedPopular, { days: POPULARITY_WINDOW_DAYS }),
              })}
        </p>
        <p className="text-faint">{c.freeNote}</p>
      </div>

      <div className="mt-3">
        <LibraryTable entries={entries} />
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[12px] text-muted">
          {fill(c.directory.range, {
            from: number.format(first),
            to: number.format(last),
            total: query ? number.format(entries.length) : total,
          })}
        </p>
        {!query && pages > 1 ? (
          <nav aria-label={fill(c.directory.page, { page, pages })} className="flex items-center gap-2 text-[12px]">
            {page > 1 ? (
              <Link
                href={directoryHref({ sort: order, query, page: page - 1 })}
                className="rounded-md border border-line bg-card px-3 py-1.5 font-medium text-ink hover:bg-subtle"
              >
                {c.previous}
              </Link>
            ) : (
              <span className="rounded-md border border-line px-3 py-1.5 text-faint">{c.previous}</span>
            )}
            <span className="px-1 text-muted">{fill(c.directory.page, { page, pages })}</span>
            {page < pages ? (
              <Link
                href={directoryHref({ sort: order, query, page: page + 1 })}
                className="rounded-md border border-line bg-card px-3 py-1.5 font-medium text-ink hover:bg-subtle"
              >
                {c.next}
              </Link>
            ) : (
              <span className="rounded-md border border-line px-3 py-1.5 text-faint">{c.next}</span>
            )}
          </nav>
        ) : null}
      </div>
    </section>
  );
}
