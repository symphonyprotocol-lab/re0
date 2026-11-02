import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { ADMIN_SOURCE_PAGE_SIZE, PREVIEW_CHILDREN_PAGE_SIZE } from '@/lib/constants';
import { param } from '@/lib/domain/list';
import { adminRee, adminReeSource, sourceFilter } from '@/lib/services/admin-rees';
import { serverMessages } from '@/i18n/server';
import { fill, formatBytes, formatDateTime, formatNumber } from '@/i18n/format';
import { Icon } from '@/components/ui/icons';
import { Fields, PageHead, Tag } from '@/components/admin/list-kit';
import { Breadcrumbs, STATE_TONES, reeBackLabel, reeBackPath, reeDetailHref, reeSourceHref, sourceParams } from '@/components/admin/ree-detail';

type Props = { params: Promise<{ id: string; kid: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The preview shows this much of a source's text; the rest stays in the database. */
const PREVIEW_CHARS = 200_000;
/** Marks drawn in one preview; the count above the text still covers every match. */
const MARKS_MAX = 1000;

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: `${t.consoleRees.ree.tabs.sources} · ${t.consoleRees.rees.title}` };
}

function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = String(whole % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** How often `query` occurs in `text`, ignoring case (prototype admin-ree-source.js `matches`). */
function countMatches(text: string, query: string): number {
  if (!query) return 0;
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  let total = 0;
  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + needle.length)) total += 1;
  return total;
}

/** `text` with the matches of `query` marked (prototype `marked`); a server-side twin of the workspace preview's `highlight`. */
function marked(text: string, query: string): ReactNode {
  if (!query) return text;
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  const parts: ReactNode[] = [];
  let at = 0;
  for (let hit = lower.indexOf(needle); hit !== -1 && parts.length < MARKS_MAX * 2; hit = lower.indexOf(needle, at)) {
    parts.push(
      text.slice(at, hit),
      <mark key={hit} className="rounded bg-[#fff1b8] px-0.5 text-ink">
        {text.slice(hit, hit + needle.length)}
      </mark>,
    );
    at = hit + needle.length;
  }
  parts.push(text.slice(at));
  return parts;
}

/**
 * `/admin/rees/[id]/sources/[kid]` (prototype admin-ree-source.js): a
 * read-only look at one source's saved text, with previous / next through
 * the sources list as it was filtered. Find-in-text (`contentQ`) marks and
 * counts matches; a site's pages or a repository's files are searchable
 * (`childQ`), 30 to a page (`childPage`), and picking one (`child`) shows
 * only its part of the text. All of it lives in the URL.
 */
export default async function AdminSourcePage({ params, searchParams }: Props) {
  const { t, locale } = await serverMessages();
  const s = t.consoleRees.source;
  const states = t.consoleRees.ree.states;
  const { id, kid } = await params;
  const query = await searchParams;
  const back = reeBackPath(query);
  const filter = sourceFilter(query);
  const valid = UUID.test(id) && UUID.test(kid);
  const [detail, found] = valid ? await Promise.all([adminRee(id), adminReeSource(id, kid, filter)]) : [null, null];
  const sourcesHref = reeDetailHref(id, back.from, 'sources', sourceParams(filter));
  const crumbs = [
    { label: t.console.nav.home, href: '/admin/overview' },
    { label: reeBackLabel(t, back.href), href: back.href },
    ...(detail ? [{ label: detail.ree.name, href: reeDetailHref(id, back.from) }] : []),
    { label: t.consoleRees.ree.tabs.sources, href: sourcesHref },
  ];
  if (!detail || !found) {
    return (
      <>
        <PageHead crumbs={crumbs} title={s.notFound} />
        <Link href={detail ? sourcesHref : back.href} className="btn-secondary">
          {detail ? s.back : t.consoleRees.ree.back}
        </Link>
      </>
    );
  }
  const { source } = found;
  const n = (value: number) => formatNumber(value, locale);
  const contentQ = param(query, 'contentQ').trim().slice(0, 200);
  const childQ = param(query, 'childQ').trim().slice(0, 200);
  const children = source.children;
  const childParam = param(query, 'child');
  const childIndex = /^\d+$/.test(childParam) && Number(childParam) < children.length ? Number(childParam) : null;
  const selected = childIndex === null ? null : children[childIndex]!;
  const needle = childQ.toLowerCase();
  const filteredChildren = children
    .map((child, index) => ({ child, index }))
    .filter(({ child }) => !needle || [child.path, child.label, child.url].filter(Boolean).join(' ').toLowerCase().includes(needle));
  const childPages = Math.max(1, Math.ceil(filteredChildren.length / PREVIEW_CHILDREN_PAGE_SIZE));
  const childPageParam = Number(param(query, 'childPage'));
  const childPage = Number.isInteger(childPageParam) && childPageParam > 1 ? Math.min(childPages, childPageParam) : 1;
  const childItems = filteredChildren.slice((childPage - 1) * PREVIEW_CHILDREN_PAGE_SIZE, childPage * PREVIEW_CHILDREN_PAGE_SIZE);
  /* Children's offsets are JS string offsets into the whole content, so the slice is taken here. */
  const full = source.content ?? '';
  const text = selected ? full.slice(selected.offset, selected.offset + selected.length) : full;
  const shown = text.length > PREVIEW_CHARS ? text.slice(0, PREVIEW_CHARS) : text;
  const matches = countMatches(shown, contentQ);
  const state = { contentQ, childQ, child: childIndex, childPage: childPage > 1 ? childPage : null };
  const previewHref = (changes: Partial<Record<keyof typeof state, string | number | null>>) =>
    reeSourceHref(id, kid, back.from, { ...sourceParams(filter), ...state, ...changes });
  /* The GET forms carry everything else on the page as hidden fields. */
  const hidden = (omit: (keyof typeof state)[]) =>
    Object.entries({ ...sourceParams(filter), ...state, from: back.from })
      .filter(([key, value]) => value !== null && value !== undefined && value !== '' && !omit.includes(key as keyof typeof state))
      .map(([key, value]) => <input key={key} type="hidden" name={key} value={String(value)} />);
  const kinds = t.common.kinds as Record<string, string>;
  const neighbour = (kidOf: string | null, position: number) =>
    kidOf ? reeSourceHref(id, kidOf, back.from, sourceParams({ q: filter.q, status: filter.status, page: Math.ceil(position / ADMIN_SOURCE_PAGE_SIZE) })) : null;
  const previous = found.position ? neighbour(found.previous, found.position - 1) : null;
  const next = found.position ? neighbour(found.next, found.position + 1) : null;
  const childLabel = source.kind === 'site' || source.kind === 'github' || source.kind === 'audio' ? s.children[source.kind] : s.children.other;
  const notice = source.state === 'failed' ? source.error || s.failed : source.state === 'processing' ? s.processing : '';
  const origin = source.source;
  const adjacent = (href: string | null, label: string, direction: 'previous' | 'next') => {
    const content =
      direction === 'previous' ? (
        <>
          <Icon name="chevronLeft" className="size-4" />
          <span className="hidden sm:inline">{label}</span>
        </>
      ) : (
        <>
          <span className="hidden sm:inline">{label}</span>
          <Icon name="chevronRight" className="size-4" />
        </>
      );
    return href ? (
      <Link href={href} className="btn-secondary btn-sm" aria-label={label} title={label}>
        {content}
      </Link>
    ) : (
      <button type="button" className="btn-secondary btn-sm" aria-label={label} disabled>
        {content}
      </button>
    );
  };

  return (
    <>
      <Breadcrumbs crumbs={[...crumbs, { label: source.title }]} />
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span className="inline-flex size-11 flex-none items-center justify-center rounded-xl bg-soft text-blue">
            <Icon name={source.kind === 'github' ? 'github' : source.kind === 'audio' ? 'audio' : 'file'} className="size-5" />
          </span>
          <div className="min-w-0">
            <h1 className="text-[22px] font-extrabold tracking-tight break-words">{source.title}</h1>
            <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
              <span className="break-words">{detail.ree.name}</span>
              <span aria-hidden="true">/</span>
              <span>{kinds[source.kind] ?? source.kind}</span>
              <Tag tone={STATE_TONES[source.state]}>{states[source.state]}</Tag>
              <Tag tone="blue">{s.readOnly}</Tag>
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label={s.sequence}>
          {adjacent(previous, s.previous, 'previous')}
          <span
            className="min-w-14 text-center font-mono text-[12px] text-muted"
            role="status"
            aria-label={found.position ? fill(s.position, { position: found.position, total: found.total }) : s.outside}
          >
            {found.position ? `${n(found.position)} / ${n(found.total)}` : s.outside}
          </span>
          {adjacent(next, s.next, 'next')}
        </div>
      </header>

      {source.deletedAt && (
        <p className="mt-4 flex gap-2 rounded-lg border border-line bg-wash px-3 py-2.5 text-[12px] text-muted">
          <Icon name="trash" className="mt-0.5 size-4 flex-none" />
          {s.deleted}
        </p>
      )}

      <section className="card mt-5 p-5">
        <Fields
          items={[
            [
              s.fields.source,
              origin ? (
                /^https?:\/\//.test(origin) ? (
                  <a key="origin" href={origin} target="_blank" rel="noreferrer noopener" className="text-link text-[13px] break-all">
                    {origin}
                  </a>
                ) : (
                  <code key="origin" className="font-mono text-[12px] break-all">
                    {origin}
                  </code>
                )
              ) : (
                '—'
              ),
            ],
            [s.fields.fileName, source.fileName ? <span className="break-all">{source.fileName}</span> : '—'],
            [s.fields.fileSize, source.fileSize ? formatBytes(source.fileSize) : '—'],
            [s.fields.chunks, n(found.chunks)],
            [s.fields.created, formatDateTime(source.createdAt, locale)],
            [s.fields.updated, formatDateTime(source.updatedAt, locale)],
            [s.fields.length, fill(s.fields.chars, { n: n(full.length) })],
          ]}
        />
      </section>

      {notice && (
        <p className={`mt-4 flex gap-2 rounded-lg px-3 py-2.5 text-[12px] ${source.state === 'failed' ? 'border border-[#f1d4d4] bg-[#fff3f3] text-red' : 'bg-soft text-[#3b4361]'}`}>
          <Icon name="info" className="mt-0.5 size-4 flex-none" />
          <span className="min-w-0 break-words">
            {notice} {full ? s.saved : s.noText}
          </span>
        </p>
      )}

      <div className={`mt-4 grid grid-cols-1 gap-4 ${children.length ? 'lg:grid-cols-[280px_minmax(0,1fr)]' : ''}`}>
        {children.length > 0 && (
          <aside className="card min-w-0 self-start overflow-hidden">
            <div className="border-b border-line px-4 py-3">
              <h2 className="flex items-center justify-between gap-2 text-[13px] font-bold">
                {childLabel}
                <small className="font-mono text-[11px] font-normal text-muted">{n(children.length)}</small>
              </h2>
              <form action={`/admin/rees/${id}/sources/${kid}`} method="get" className="mt-2 flex gap-2">
                {hidden(['childQ', 'childPage'])}
                <input
                  name="childQ"
                  type="search"
                  defaultValue={childQ}
                  maxLength={200}
                  placeholder={s.childSearch}
                  aria-label={s.childSearchLabel}
                  className="min-w-0 flex-1 rounded-lg border border-line bg-white px-2.5 py-1.5 text-[12px] outline-none focus:border-blue"
                />
                <button type="submit" className="btn-secondary btn-sm" aria-label={s.find} title={s.find}>
                  <Icon name="search" className="size-3.5" />
                </button>
              </form>
            </div>
            {selected && (
              <Link href={previewHref({ child: null })} className="text-link block border-b border-line px-4 py-2 text-[12px]">
                {s.allText}
              </Link>
            )}
            <ol className="max-h-[420px] overflow-y-auto py-1 text-[12px] lg:max-h-[640px]">
              {childItems.map(({ child, index }) => (
                <li key={index}>
                  <Link
                    href={previewHref({ child: index })}
                    aria-current={index === childIndex ? 'true' : undefined}
                    className={`block px-4 py-1.5 hover:bg-wash ${index === childIndex ? 'bg-soft font-semibold text-blue' : ''}`}
                  >
                    {child.time !== undefined && <span className="mr-2 font-mono text-[11px] text-muted">{clock(child.time)}</span>}
                    <span className="break-all">{child.path || child.label || (child.time === undefined ? s.untitled : '')}</span>
                    {child.url && <small className="block truncate text-[11px] font-normal text-muted" title={child.url}>{child.url}</small>}
                  </Link>
                </li>
              ))}
            </ol>
            {filteredChildren.length === 0 && <p className="px-4 py-4 text-center text-[11px] text-muted">{s.childEmpty}</p>}
            {childPages > 1 && (
              <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-2 text-[11px] text-muted">
                {childPage > 1 ? (
                  <Link href={previewHref({ childPage: childPage - 1 > 1 ? childPage - 1 : null })} className="icon-btn" aria-label={s.childPrevious} title={s.childPrevious}>
                    <Icon name="chevronLeft" className="size-4" />
                  </Link>
                ) : (
                  <span className="icon-btn opacity-40" aria-disabled="true">
                    <Icon name="chevronLeft" className="size-4" />
                  </span>
                )}
                <span className="font-mono">{fill(s.childPages, { page: childPage, pages: childPages })}</span>
                {childPage < childPages ? (
                  <Link href={previewHref({ childPage: childPage + 1 })} className="icon-btn" aria-label={s.childNext} title={s.childNext}>
                    <Icon name="chevronRight" className="size-4" />
                  </Link>
                ) : (
                  <span className="icon-btn opacity-40" aria-disabled="true">
                    <Icon name="chevronRight" className="size-4" />
                  </span>
                )}
              </div>
            )}
          </aside>
        )}
        <section className="card min-w-0 overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
            <div className="min-w-0">
              <h2 className="text-[13px] font-bold break-all">
                {selected ? selected.path || selected.label || s.untitled : source.kind === 'audio' ? s.transcript : s.text}
              </h2>
              {selected?.url && <p className="truncate text-[11px] text-muted">{selected.url}</p>}
            </div>
            <form action={`/admin/rees/${id}/sources/${kid}`} method="get" className="flex min-w-0 gap-2">
              {hidden(['contentQ'])}
              <input
                name="contentQ"
                type="search"
                defaultValue={contentQ}
                maxLength={200}
                placeholder={s.contentSearch}
                aria-label={s.contentSearchLabel}
                className="w-[200px] min-w-0 rounded-lg border border-line bg-white px-2.5 py-1.5 text-[12px] outline-none focus:border-blue"
              />
              <button type="submit" className="btn-secondary btn-sm">
                {s.find}
              </button>
            </form>
          </div>
          {contentQ && (
            <p className="flex items-center gap-3 border-b border-line bg-wash px-4 py-2 text-[12px] text-muted" role="status">
              {fill(s.matches, { n: n(matches) })}
              <Link href={previewHref({ contentQ: null })} className="text-link text-[12px]">
                {s.clear}
              </Link>
            </p>
          )}
          {text.length > PREVIEW_CHARS && (
            <p className="border-b border-line bg-[#fff7ec] px-4 py-2 text-[11px] text-orange">{fill(s.truncated, { shown: n(PREVIEW_CHARS), total: n(text.length) })}</p>
          )}
          {shown ? (
            <pre className="max-h-[70vh] overflow-auto px-4 py-3 font-sans text-[13px] leading-relaxed break-words whitespace-pre-wrap">{marked(shown, contentQ)}</pre>
          ) : (
            <p className="px-4 py-12 text-center text-[12px] text-muted">{s.noText}</p>
          )}
          <p className="border-t border-line px-4 py-2 text-[11px] text-muted">{s.footer}</p>
        </section>
      </div>

      <div className="mt-5">
        <Link href={sourcesHref} className="btn-secondary btn-sm">
          <Icon name="arrowLeft" className="size-3.5" />
          {s.back}
        </Link>
      </div>
    </>
  );
}
