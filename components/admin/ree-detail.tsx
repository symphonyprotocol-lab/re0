/**
 * The console's Ree pieces in the prototype's markup (admin-ree.js,
 * admin-ree-detail.js, suite.js `dotsTable`), styled by console.css: the Ree
 * avatar, a list row's actions, the list's pages, the detail header with the
 * takedown / restore, metric cards, tabs as links (in the top bar's actions),
 * and the overview and sources tabs. Server components; the takedown and
 * restore dialogs are the shared `ReasonAction`.
 */
import Link from 'next/link';
import { Fragment, type ReactNode } from 'react';
import { QUERY_BASE_FEE } from '@/lib/constants';
import type { AdminReeDetail, SourceFilter } from '@/lib/services/admin-rees';
import { ADMIN_SOURCE_STATES } from '@/lib/services/admin-rees';
import type { Locale, Messages } from '@/i18n';
import { fill, formatDateTime, formatNumber } from '@/i18n/format';
import { imageUrl } from '@/components/ui/ree-avatar';
import { CI } from '@/components/admin/console-icon';
import { PageJump, ReasonAction } from '@/components/admin/list-client';
import { RecordsTable, pageNumbers } from '@/components/admin/list-kit';
// console.css first, so these later prototype rules keep their cascade order.
import '@/components/admin/console.css';
import '@/components/admin/console-rees.css';

/** Status tag tones (prototype `statusBadge`: taken down orange, public blue, private plain). */
export const VISIBILITY_TONES = { public: 'blue', private: 'grey', moderated: 'orange' } as const;
export const STATE_TONES = { ready: 'green', processing: 'grey', failed: 'red', paused: 'grey' } as const;
const TONE_CLASS = { blue: 'blue', grey: '', orange: 'orange', green: 'green', red: 'red' } as const;

export const REE_TABS = ['overview', 'sources', 'statistics', 'audit'] as const;
export type ReeTab = (typeof REE_TABS)[number];

type Params = Record<string, string | string[] | undefined>;
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? '';

export function reeTab(params: Params): ReeTab {
  const tab = first(params.tab);
  return (REE_TABS as readonly string[]).includes(tab) ? (tab as ReeTab) : 'overview';
}

/**
 * Where "back" goes: the list (or a user's Rees tab, or the verification
 * request whose public Ree was opened) the administrator came from, taken
 * only when it is one of those console pages.
 */
export function reeBackPath(params: Params): { href: string; from: string | null } {
  const raw = first(params.from).slice(0, 2000);
  const allowed = raw === '/admin/rees' || raw.startsWith('/admin/rees?') || raw.startsWith('/admin/users/') || /^\/admin\/verifications(?:[/?]|$)/.test(raw);
  if (allowed && !raw.includes('\\') && !raw.includes('//')) return { href: raw, from: raw };
  return { href: '/admin/rees', from: null };
}

/** The crumb for that way back (prototype suite.js `consoleHeader`: 名下 Ree from a user's tab). */
export function reeBackLabel(t: Messages, href: string): string {
  if (href.startsWith('/admin/users/')) return t.consoleRees.ree.ownerRees;
  if (href.startsWith('/admin/verifications')) return t.console.nav.verifications;
  return t.consoleRees.rees.title;
}

/** A plain status tag without the leading dot (prototype `statusBadge`, the sources table's state). */
function StateTag({ tone, children }: { tone: keyof typeof TONE_CLASS; children: ReactNode }) {
  return <span className={`tag ${TONE_CLASS[tone]}`}>{children}</span>;
}

/** The Ree's avatar (prototype dot-avatar.js `renderDotAvatar`): its photo, or the knowledge-node mark on its color. */
export function ConsoleReeAvatar({ avatar, color, small = false }: { avatar?: string | null; color?: string | null; small?: boolean }) {
  const src = imageUrl(avatar);
  const tint = color && ['lilac', 'sand', 'sage', 'rose', 'slate'].includes(color) ? color : '';
  return (
    <span className={`dot-avatar ${tint} ${small ? 'sm' : ''}`} aria-hidden="true">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" />
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
          <path d="M8.3 5.1a7.8 7.8 0 0 1 10.6 10.6M15.7 18.9A7.8 7.8 0 0 1 5.1 8.3" />
          <circle cx="6" cy="6" r="1.7" fill="currentColor" stroke="none" />
          <circle cx="18" cy="18" r="1.7" fill="currentColor" stroke="none" />
        </svg>
      )}
    </span>
  );
}

/** The takedown (public) or restore (taken down) dialog behind a button (prototype `moderate-dot`). */
function ModerateAction({ t, ree, label }: { t: Messages; ree: { id: string; name: string; visibility: 'public' | 'private' | 'moderated' }; label: { takedown: string; restore: string } }) {
  const r = t.consoleRees.ree;
  if (ree.visibility === 'public')
    return (
      <ReasonAction
        endpoint={`/api/admin/rees/${ree.id}/takedown`}
        label={label.takedown}
        title={r.takedown.title}
        subtitle={ree.name}
        body={r.takedown.body}
        confirmLabel={r.takedown.confirm}
      />
    );
  if (ree.visibility === 'moderated')
    return (
      <ReasonAction
        endpoint={`/api/admin/rees/${ree.id}/restore`}
        label={label.restore}
        title={r.restore.title}
        subtitle={ree.name}
        body={r.restore.body}
        confirmLabel={r.restore.confirm}
      />
    );
  return null;
}

/**
 * A Ree row's actions in the console lists (prototype suite.js `dotsTable`):
 * details, the public page while public, and the takedown / restore dialog.
 */
export function ReeRowActions({
  t,
  ree,
  detailHref,
}: {
  t: Messages;
  ree: { id: string; name: string; slug: string; visibility: 'public' | 'private' | 'moderated'; deleted?: boolean };
  detailHref: string;
}) {
  const r = t.consoleRees.rees;
  return (
    <div className="flex">
      <Link href={detailHref} className="text-link">
        {r.details}
      </Link>
      {!ree.deleted && ree.visibility === 'public' && (
        <Link href={`/r/${ree.slug}`} className="icon-btn" target="_blank" rel="noreferrer" aria-label={r.publicPage} title={r.publicPage}>
          <CI name="external" />
        </Link>
      )}
      {!ree.deleted && <ModerateAction t={t} ree={ree} label={{ takedown: r.takedown, restore: r.restore }} />}
    </div>
  );
}

/** The Ree list's pages (admin-ree.js `pager`): "第 n / m 页", the numbered pages and "跳至". */
export function ReePager({ t, page, total, size, href }: { t: Messages; page: number; total: number; size: number; href: (page: number) => string }) {
  const l = t.console.list;
  const pages = Math.max(1, Math.ceil(total / size));
  const step = (target: number, label: string) =>
    target < 1 || target > pages ? (
      <span className="is-disabled" aria-disabled="true">
        <CI name="chevron" />
      </span>
    ) : (
      <Link href={href(target)} aria-label={label}>
        <CI name="chevron" />
      </Link>
    );
  return (
    <div className="admin-ree-pagination">
      <span>{fill(l.page, { page, pages })}</span>
      <nav className="admin-ree-pages" aria-label={t.consoleRees.rees.pagination}>
        {step(page - 1, l.previous)}
        {pageNumbers(page, pages).map((value, index) =>
          value === null ? (
            <span key={`gap-${index}`} className="pagination-ellipsis">
              …
            </span>
          ) : value === page ? (
            <span key={value} className="is-current" aria-current="page">
              {value}
            </span>
          ) : (
            <Link key={value} href={href(value)} aria-label={fill(l.pageLabel, { page: value })}>
              {value}
            </Link>
          ),
        )}
        {step(page + 1, l.next)}
      </nav>
      <PageJump page={page} pages={pages} formId="admin-ree-page-jump" />
    </div>
  );
}

type Extra = Record<string, string | number | null | undefined>;

function withQuery(path: string, params: Extra, from: string | null): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== null && value !== undefined && value !== '') query.set(key, String(value));
  if (from) query.set('from', from);
  const text = query.toString();
  return text ? `${path}?${text}` : path;
}

/** The source list's filter as URL params, defaults left out. */
export function sourceParams(filter: { q: string; status: string; page?: number }): Extra {
  return { sourceQ: filter.q || null, sourceStatus: filter.status !== 'all' ? filter.status : null, sourcePage: filter.page && filter.page > 1 ? filter.page : null };
}

export function reeDetailHref(id: string, from: string | null, tab: ReeTab = 'overview', params: Extra = {}): string {
  return withQuery(`/admin/rees/${id}`, { tab: tab === 'overview' ? null : tab, ...params }, from);
}

export function reeSourceHref(id: string, kid: string, from: string | null, params: Extra = {}): string {
  return withQuery(`/admin/rees/${id}/sources/${kid}`, params, from);
}

/* --------------------------------------------------------------- header */

/**
 * The detail's head and metrics (admin-ree-detail.js `page`): avatar, name
 * and status, description, the public page and takedown / restore; then a
 * note when the Ree is deleted or taken down, and the four metric cards.
 */
export function ReeHeader({ t, locale, detail, answers }: { t: Messages; locale: Locale; detail: AdminReeDetail; answers: number }) {
  const r = t.consoleRees.ree;
  const { ree, visibility, sources } = detail;
  const n = (value: number) => formatNumber(value, locale);
  const deleted = Boolean(ree.deletedAt);
  return (
    <>
      <header className="admin-ree-detail-head">
        <div className="flex">
          <ConsoleReeAvatar avatar={ree.avatarBlob} color={ree.color} />
          <div>
            <div className="flex">
              <h1>{ree.name}</h1>
              <StateTag tone={VISIBILITY_TONES[visibility]}>{t.consoleRees.rees.visibility[visibility]}</StateTag>
            </div>
            {ree.description && <p>{ree.description}</p>}
          </div>
        </div>
        <div className="flex admin-ree-detail-actions">
          {!deleted && visibility === 'public' && (
            <Link href={`/r/${ree.slug}`} className="btn secondary sm" target="_blank" rel="noreferrer">
              <CI name="external" />
              {r.publicPage}
            </Link>
          )}
          {!deleted && <ModerateAction t={t} ree={{ id: ree.id, name: ree.name, visibility }} label={{ takedown: r.takedown.label, restore: r.restore.label }} />}
        </div>
      </header>
      {deleted && (
        <div className="info-strip mb16">
          <CI name="info" />
          <span>{r.deleted}</span>
        </div>
      )}
      {visibility === 'moderated' && ree.moderatedAt && (
        <div className="info-strip mb16">
          <CI name="info" />
          <span>
            {fill(r.moderated, { time: formatDateTime(ree.moderatedAt, locale) })}
            {ree.moderatedReason && ` · ${fill(r.moderatedReason, { reason: ree.moderatedReason })}`}
          </span>
        </div>
      )}
      <div className="admin-ree-detail-metrics">
        {(
          [
            [r.metrics.answers, n(answers), r.metrics.answersNote],
            [r.metrics.sources, n(sources.total), r.metrics.sourcesNote],
            [r.metrics.ready, n(sources.ready), r.metrics.readyNote],
          ] as const
        ).map(([label, value, note]) => (
          <article key={label} className="card">
            <span>{label}</span>
            <strong>{value}</strong>
            <small>{note}</small>
          </article>
        ))}
        <article className="card admin-ree-fee-metric" title={fill(r.metrics.priceHint, { base: n(QUERY_BASE_FEE) })}>
          <span>{r.metrics.price}</span>
          <strong>
            {n(QUERY_BASE_FEE + ree.queryFee)}
            <em>{r.metrics.priceUnit}</em>
          </strong>
          <small>
            {fill(r.metrics.priceNote, { base: n(QUERY_BASE_FEE), fee: n(ree.queryFee) })}
            <br />
            {r.metrics.priceNote2}
          </small>
        </article>
      </div>
    </>
  );
}

/** The four tabs as links, inline in the top bar's actions (`.admin-ree-detail-nav`); `from` rides along. */
export function ReeTabsNav({ t, id, from, active }: { t: Messages; id: string; from: string | null; active: ReeTab }) {
  return (
    <nav className="admin-ree-detail-nav admin-ree-inline-tabs" aria-label={t.consoleRees.ree.tabsLabel}>
      {REE_TABS.map((tab) => (
        <Link key={tab} href={reeDetailHref(id, from, tab)} className={tab === active ? 'active' : undefined} aria-current={tab === active ? 'page' : undefined}>
          {t.consoleRees.ree.tabs[tab]}
        </Link>
      ))}
    </nav>
  );
}

/* ------------------------------------------------------------- overview */

function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function ReeOverviewTab({ t, locale, detail, from }: { t: Messages; locale: Locale; detail: AdminReeDetail; from: string | null }) {
  const r = t.consoleRees.ree;
  const { ree, sources } = detail;
  const n = (value: number) => formatNumber(value, locale);
  const category = (t.common.categories as Record<string, string>)[ree.category] ?? ree.category;
  return (
    <div className="admin-ree-detail-grid">
      <div>
        <section className="card admin-ree-section">
          <h2>{r.identity.title}</h2>
          <dl className="admin-ree-fields">
            <Field label={r.identity.id}>
              <code>{ree.id}</code>
            </Field>
            <Field label={r.identity.slug}>{ree.slug || '—'}</Field>
            <Field label={r.identity.category}>{category}</Field>
            <Field label={r.identity.tags}>
              {ree.tags.length
                ? ree.tags.map((tag, index) => (
                    <Fragment key={tag}>
                      {index > 0 && ' '}
                      <span className="tag">{tag}</span>
                    </Fragment>
                  ))
                : '—'}
            </Field>
            <Field label={r.identity.video}>{detail.hasVideo ? r.identity.videoReady : r.identity.videoNone}</Field>
            <Field label={r.identity.created}>{formatDateTime(ree.createdAt, locale)}</Field>
            <Field label={r.identity.updated}>{formatDateTime(ree.updatedAt, locale)}</Field>
          </dl>
        </section>
        <section className="card admin-ree-section">
          <h2>{r.prompt.title}</h2>
          <p className="admin-ree-pre">{ree.systemPrompt || r.prompt.empty}</p>
          <h3>{r.prompt.samples}</h3>
          {ree.sampleQuestions.length ? (
            <ol className="admin-ree-samples">
              {ree.sampleQuestions.map((question, index) => (
                <li key={index}>{question}</li>
              ))}
            </ol>
          ) : (
            <p className="muted small">{r.prompt.noSamples}</p>
          )}
        </section>
      </div>
      <aside>
        <section className="card admin-ree-section">
          <h2>{r.owner.title}</h2>
          <strong>{detail.ownerName}</strong>
          <p className="muted small">{detail.ownerEmail || '—'}</p>
          <Link href={`/admin/users/${ree.ownerId}`} className="text-link">
            {r.owner.view}
            <CI name="arrow" />
          </Link>
        </section>
        <section className="card admin-ree-section">
          <h2>{r.readiness.title}</h2>
          <div className="admin-ree-source-summary">
            {(['ready', 'processing', 'failed', 'paused'] as const).map((state) => (
              <Link key={state} href={reeDetailHref(ree.id, from, 'sources', { sourceStatus: state })} className="admin-ree-source-count">
                <span>{r.states[state]}</span>
                <strong>{n(sources[state])}</strong>
              </Link>
            ))}
          </div>
        </section>
      </aside>
    </div>
  );
}

/* -------------------------------------------------------------- sources */

export function ReeSourcesTab({
  t,
  locale,
  id,
  from,
  filter,
  data,
}: {
  t: Messages;
  locale: Locale;
  id: string;
  from: string | null;
  filter: SourceFilter;
  data: { items: { id: string; title: string; kind: string; state: keyof typeof STATE_TONES; updatedAt: Date }[]; total: number; page: number; size: number };
}) {
  const s = t.consoleRees.ree.sources;
  const states = t.consoleRees.ree.states;
  const pages = Math.max(1, Math.ceil(data.total / data.size));
  const keep = { q: filter.q, status: filter.status };
  const pageHref = (page: number) => reeDetailHref(id, from, 'sources', sourceParams({ ...keep, page }));
  const filtered = Boolean(filter.q) || filter.status !== 'all';
  const kinds = t.common.kinds as Record<string, string>;
  const [before, after] = s.total.split('{total}');
  return (
    <section className="card admin-ree-source-table">
      {/* A plain GET form: changing the filter starts again at page 1. */}
      <form action={`/admin/rees/${id}`} method="get" className="admin-ree-filter" id="admin-ree-source-filter">
        <div className="search-small">
          <CI name="search" />
          <input name="sourceQ" defaultValue={filter.q} maxLength={400} placeholder={s.search} aria-label={s.searchLabel} />
        </div>
        <select name="sourceStatus" defaultValue={filter.status} aria-label={s.statusLabel}>
          {ADMIN_SOURCE_STATES.map((state) => (
            <option key={state} value={state}>
              {state === 'all' ? s.allStatuses : states[state]}
            </option>
          ))}
        </select>
        <button type="submit" className="btn secondary sm">
          {s.filter}
        </button>
        {filtered && (
          <Link href={reeDetailHref(id, from, 'sources')} className="text-link">
            {s.reset}
          </Link>
        )}
        <input type="hidden" name="tab" value="sources" />
        {from && <input type="hidden" name="from" value={from} />}
      </form>
      <div className="admin-ree-results" role="status">
        {before}
        <strong>{formatNumber(data.total, locale)}</strong>
        {fill(after ?? '', { size: data.size })}
      </div>
      <RecordsTable
        label={s.region}
        empty={s.empty}
        head={[s.columns.title, s.columns.kind, s.columns.state]}
        rows={data.items.map((source) => [
          <Link key="title" href={reeSourceHref(id, source.id, from, sourceParams({ ...keep, page: data.page }))} className="admin-ree-source-link">
            <CI name="file" />
            <span>{source.title}</span>
            <CI name="external" />
          </Link>,
          kinds[source.kind] ?? source.kind,
          <StateTag key="state" tone={STATE_TONES[source.state]}>
            {states[source.state]}
          </StateTag>,
        ])}
      />
      <div className="admin-ree-pagination">
        <span>{fill(s.page, { page: data.page, pages })}</span>
        <div className="flex">
          {data.page > 1 ? (
            <Link href={pageHref(data.page - 1)} className="btn secondary sm">
              {s.previous}
            </Link>
          ) : (
            <button type="button" className="btn secondary sm" disabled>
              {s.previous}
            </button>
          )}
          {data.page < pages ? (
            <Link href={pageHref(data.page + 1)} className="btn secondary sm">
              {s.next}
            </Link>
          ) : (
            <button type="button" className="btn secondary sm" disabled>
              {s.next}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
