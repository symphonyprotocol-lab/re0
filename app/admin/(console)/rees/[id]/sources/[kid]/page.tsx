import type { Metadata } from 'next';
import { requireAdministrator } from '@/lib/http/admin';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import type { ReactNode } from 'react';
import { ADMIN_SOURCE_PAGE_SIZE, PREVIEW_CHILDREN_PAGE_SIZE } from '@/lib/constants';
import { param } from '@/lib/domain/list';
import { adminRee, adminReeSource, sourceFilter } from '@/lib/services/admin-rees';
import { serverMessages } from '@/i18n/server';
import { fill, formatBytes, formatDateTime, formatNumber } from '@/i18n/format';
import { CI } from '@/components/admin/console-icon';
import { ConsolePage, ConsoleTopbar } from '@/components/admin/console-topbar';
import { reeBackLabel, reeBackPath, reeDetailHref, reeSourceHref, sourceParams } from '@/components/admin/ree-detail';

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

/**
 * `text` with the matches of `query` marked (prototype `marked`); `budget`
 * counts the marks left for the whole preview.
 */
function marked(text: string, query: string, budget: { left: number }): ReactNode {
  if (!query) return text;
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  const parts: ReactNode[] = [];
  let at = 0;
  for (let hit = lower.indexOf(needle); hit !== -1 && budget.left > 0; hit = lower.indexOf(needle, at)) {
    budget.left -= 1;
    parts.push(text.slice(at, hit), <mark key={hit}>{text.slice(hit, hit + needle.length)}</mark>);
    at = hit + needle.length;
  }
  parts.push(text.slice(at));
  return parts;
}

/** The saved text as the prototype's reader shows it (`body`): code as one block, else `#` headings, paragraphs and gaps. */
function ContentBody({ text, query, code }: { text: string; query: string; code: boolean }) {
  const budget = { left: MARKS_MAX };
  if (code) return <pre className="admin-source-code">{marked(text, query, budget)}</pre>;
  return text.split('\n').map((line, index) => {
    const heading = /^(#{1,3}) (.*)$/.exec(line);
    if (heading) {
      const Tag = `h${heading[1]!.length + 1}` as 'h2' | 'h3' | 'h4';
      return <Tag key={index}>{marked(heading[2]!, query, budget)}</Tag>;
    }
    return line.trim() ? <p key={index}>{marked(line, query, budget)}</p> : <div key={index} className="admin-source-gap" />;
  });
}

/**
 * `/admin/rees/[id]/sources/[kid]` (prototype admin-ree-source.js): a
 * read-only look at one source's saved text, with previous / next through
 * the sources list as it was filtered (in the top bar's second row, beside
 * the crumbs that lead back). Find-in-text (`contentQ`) marks and
 * counts matches; a site's pages or a repository's files are searchable
 * (`childQ`), 30 to a page (`childPage`), and picking one (`child`) shows
 * only its part of the text. All of it lives in the URL.
 */
export default async function AdminSourcePage({ params, searchParams }: Props) {
  const administrator = await requireAdministrator();
  const { t, locale } = await serverMessages();
  const s = t.consoleRees.source;
  const states = t.consoleRees.ree.states;
  const { id, kid } = await params;
  const query = await searchParams;
  const back = reeBackPath(query);
  const filter = sourceFilter(query);
  const valid = UUID.test(id) && UUID.test(kid);
  const [detail, found] = valid ? await Promise.all([adminRee(administrator, id), adminReeSource(administrator, id, kid, filter)]) : [null, null];
  const sourcesHref = reeDetailHref(id, back.from, 'sources', sourceParams(filter));
  const crumbs = [
    { label: t.console.nav.home, href: '/admin/overview' },
    { label: reeBackLabel(t, back.href), href: back.href },
    ...(detail ? [{ label: detail.ree.name, href: reeDetailHref(id, back.from) }] : []),
    { label: t.consoleRees.ree.tabs.sources, href: sourcesHref },
  ];
  if (!detail || !found) {
    return (
      <ConsolePage>
        <ConsoleTopbar crumbs={[...crumbs, { label: s.notFound }]} />
        <section className="card empty">
          <h1>{s.notFound}</h1>
          <Link href={detail ? sourcesHref : back.href} className="btn secondary mt16">
            {detail ? s.back : t.consoleRees.ree.back}
          </Link>
        </section>
      </ConsolePage>
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
  /* The GET forms carry everything else on the page as hidden fields (after the visible ones). */
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
  const adjacent = (href: string | null, label: string, direction: 'previous' | 'next', title?: string) => {
    const content =
      direction === 'previous' ? (
        <>
          <CI name="chevron" />
          <span>{label}</span>
        </>
      ) : (
        <>
          <span>{label}</span>
          <CI name="chevron" />
        </>
      );
    return href ? (
      <Link href={href} className={`admin-source-adjacent ${direction}`} aria-label={label} title={title}>
        {content}
      </Link>
    ) : (
      <button type="button" className={`admin-source-adjacent ${direction}`} aria-label={label} disabled>
        {content}
      </button>
    );
  };
  const code = source.kind === 'github' && selected !== null && !/\.(md|txt|markdown)$/i.test(selected.path ?? '');
  const meta = (label: string, value: ReactNode) => (
    <div>
      <dt>{label}</dt>
      <dd>{value || s.notRecorded}</dd>
    </div>
  );

  return (
    <ConsolePage>
      <ConsoleTopbar
        crumbs={[...crumbs, { label: source.title }]}
        actions={
          <div className="admin-source-sequence" role="group" aria-label={s.sequence}>
            {adjacent(previous, s.previous, 'previous')}
            <span className="admin-source-position" role="status" aria-label={found.position ? fill(s.position, { position: found.position, total: found.total }) : s.outside}>
              {found.position ? `${n(found.position)} / ${n(found.total)}` : s.outside}
            </span>
            {adjacent(next, s.next, 'next')}
          </div>
        }
      />
      <div className="admin-source-preview">
        <header className="admin-source-head">
          <span className="file-icon">
            <CI name={source.kind === 'github' ? 'github' : source.kind === 'audio' ? 'audio' : 'file'} />
          </span>
          <div>
            <h1>{source.title}</h1>
            <p>
              {detail.ree.name}
              <span> / </span>
              {kinds[source.kind] ?? source.kind}
              <span> / </span>
              {states[source.status === 'ready' || source.status === 'failed' ? source.status : 'processing']}
              {source.state === 'paused' && ` · ${s.paused}`}
            </p>
          </div>
          <span className="tag blue">{s.readOnly}</span>
        </header>
        <div className="card admin-source-meta">
          <dl>
            {meta(
              s.fields.location,
              origin ? (
                /^https?:\/\//.test(origin) ? (
                  <a href={origin} target="_blank" rel="noreferrer noopener" className="text-link">
                    {origin}
                  </a>
                ) : (
                  origin
                )
              ) : null,
            )}
            {meta(s.fields.origin, source.fileName ? (source.fileSize ? `${source.fileName} · ${formatBytes(source.fileSize)}` : source.fileName) : null)}
            {meta(s.fields.updated, formatDateTime(source.updatedAt, locale))}
            {meta(s.fields.length, `${fill(s.fields.chars, { n: n(full.length) })} · ${fill(s.fields.chunks, { n: n(found.chunks) })}`)}
          </dl>
        </div>
        {source.deletedAt && (
          <div className="info-strip admin-source-notice">
            <CI name="trash" />
            <span>{s.deleted}</span>
          </div>
        )}
        {notice && (
          <div className="info-strip admin-source-notice">
            <CI name="info" />
            <span>
              {notice} {full ? s.saved : s.noText}
            </span>
          </div>
        )}
        <div className={`admin-source-layout ${children.length ? 'has-collection' : ''}`}>
          {children.length > 0 && (
            <aside className="card admin-source-collection">
              <div className="admin-source-collection-head">
                <h2>
                  {childLabel} <small>{n(children.length)}</small>
                </h2>
                <form action={`/admin/rees/${id}/sources/${kid}`} method="get" id="admin-source-child-search">
                  <input name="childQ" defaultValue={childQ} maxLength={200} placeholder={s.childSearch} aria-label={s.childSearchLabel} />
                  <button type="submit" className="btn secondary sm">
                    <CI name="search" />
                    {s.find}
                  </button>
                  {hidden(['childQ', 'childPage'])}
                </form>
              </div>
              <div className="admin-source-child-list">
                <Link href={previewHref({ child: null })} className={childIndex === null ? 'active' : undefined} aria-current={childIndex === null ? 'true' : undefined}>
                  <CI name="layers" />
                  <span>{s.allText}</span>
                </Link>
                {childItems.map(({ child, index }) => (
                  <Link key={index} href={previewHref({ child: index })} className={index === childIndex ? 'active' : undefined} aria-current={index === childIndex ? 'true' : undefined}>
                    <CI name={source.kind === 'github' ? 'code' : source.kind === 'audio' ? 'clock' : 'file'} />
                    <span>{[child.time !== undefined ? clock(child.time) : '', child.path || child.label || (child.time === undefined ? s.untitled : '')].filter(Boolean).join(' ')}</span>
                  </Link>
                ))}
                {filteredChildren.length === 0 && <p className="small muted">{s.childEmpty}</p>}
              </div>
              <div className="admin-source-child-pagination">
                <span>{fill(s.childPages, { page: childPage, pages: childPages })}</span>
                {childPage > 1 && (
                  <Link href={previewHref({ childPage: childPage - 1 > 1 ? childPage - 1 : null })} className="text-link">
                    {s.childPrevious}
                  </Link>
                )}
                {childPage < childPages && (
                  <Link href={previewHref({ childPage: childPage + 1 })} className="text-link">
                    {s.childNext}
                  </Link>
                )}
              </div>
            </aside>
          )}
          <section className="card admin-source-reader">
            <div className="admin-source-reader-head">
              <div>
                <h2>{selected ? selected.path || selected.label || s.untitled : source.kind === 'audio' ? s.transcript : s.text}</h2>
                {selected?.url && <p>{selected.url}</p>}
              </div>
              <form action={`/admin/rees/${id}/sources/${kid}`} method="get" id="admin-source-content-search">
                <input name="contentQ" defaultValue={contentQ} maxLength={200} placeholder={s.contentSearch} aria-label={s.contentSearchLabel} />
                <button type="submit" className="btn secondary sm">
                  {s.find}
                </button>
                {hidden(['contentQ'])}
              </form>
            </div>
            {contentQ && (
              <div className="admin-source-search-result" role="status">
                {fill(s.matches, { n: n(matches) })}
                <Link href={previewHref({ contentQ: null })} className="text-link">
                  {s.clear}
                </Link>
              </div>
            )}
            {text.length > PREVIEW_CHARS && <div className="admin-source-search-result">{fill(s.truncated, { shown: n(PREVIEW_CHARS), total: n(text.length) })}</div>}
            <article className="admin-source-content">
              {shown ? (
                <ContentBody text={shown} query={contentQ} code={code} />
              ) : (
                <div className="empty">
                  <h3>{s.emptyTitle}</h3>
                  <p>{s.emptyBody}</p>
                </div>
              )}
            </article>
            <footer>{s.footer}</footer>
          </section>
        </div>
      </div>
    </ConsolePage>
  );
}
