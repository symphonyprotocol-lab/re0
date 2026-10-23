'use client';

import Link from 'next/link';
import { PANEL } from '@/components/dashboard/ui';
import { CircleCheckIcon, CircleXIcon } from '@/components/ui/icons';
import { REQUEST_ENTRYPOINTS, REQUEST_STATUSES } from '@/lib/domain/request-log';
import { useI18n } from '@/lib/i18n/client';
import { fill } from '@/lib/i18n/format';

const GRID =
  'grid grid-cols-[118px_minmax(0,1fr)_90px_110px_58px_52px_62px] items-center gap-3';

/** What one row of the live log renders. Mapped from the API by the page. */
export interface RequestLogView {
  /** The log row's own key, unique; `requestId` may repeat across rows of one request. */
  id: string;
  requestId: string;
  time: string;
  operation: string;
  surface: string;
  library: string;
  key: string;
  status: number;
  latency: string;
  tokens: string;
}

/** The filter as the URL carries it: strings, so it serialises to the client. */
export interface RequestLogFilterView {
  q: string;
  from: string;
  to: string;
  status: string;
  entrypoint: string;
  library: string;
}

const FIELD =
  'h-[26px] rounded-md border border-line bg-card px-1.5 text-[10px] text-steel focus:outline-none';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[9px] text-muted">{label}</span>
      {children}
    </label>
  );
}

/** Status pill: 2xx reads as brand green, everything else as an error. */
function StatusPill({ status }: { status: number }) {
  const ok = status < 400;
  return (
    <span
      className={`inline-flex w-fit items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] whitespace-nowrap ${
        ok ? 'bg-pubsoft text-pubink' : 'bg-errsoft text-err'
      }`}
    >
      {ok ? <CircleCheckIcon size={12} /> : <CircleXIcon size={12} />}
      {status}
    </span>
  );
}

/** Any change applies at once; the button stays for keyboards and no-JS. */
function applyOnChange(event: React.ChangeEvent<HTMLSelectElement | HTMLInputElement>) {
  event.currentTarget.form?.requestSubmit();
}

/**
 * Request log with its filter bar -- design source frame `i027cz`, fed by the
 * page from the real request_log (architecture.md 6.3). The bar is a GET
 * form: every filter is a URL parameter the server applies, so a filtered
 * page is a link, the count in the footer is the database's, and the export
 * takes exactly the same parameters.
 */
export function RequestLog({
  entries,
  filter,
  libraries,
  total,
  page,
  pageCount,
  previousHref,
  nextHref,
  exportHref,
}: {
  entries: RequestLogView[];
  filter: RequestLogFilterView;
  libraries: { publicId: string; title: string }[];
  total: number;
  page: number;
  pageCount: number;
  /* Server-rendered: a client component cannot be handed a function to call. */
  previousHref: string;
  nextHref: string;
  exportHref: string;
}) {
  const { t } = useI18n();
  const r = t.dashboard.requests;
  const f = r.filters;

  return (
    <section className={`${PANEL} overflow-hidden p-0.5`}>
      <form
        method="get"
        action="/dashboard/requests"
        className="flex flex-wrap items-end gap-3 border-b border-line px-[18px] pt-3.5 pb-4"
      >
        <label className="flex h-[37px] min-w-[240px] flex-1 items-center gap-2 rounded-md border border-line bg-field px-3">
          <svg
            aria-hidden
            viewBox="0 0 24 24"
            width={15}
            height={15}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="shrink-0 text-muted"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            type="search"
            name="q"
            defaultValue={filter.q}
            maxLength={200}
            placeholder={r.searchPlaceholder}
            className="min-w-0 flex-1 bg-transparent text-[12px] text-ink placeholder:text-muted/70 focus:outline-none"
          />
        </label>

        <div className="flex flex-wrap items-end gap-1.5">
          <Field label={f.from}>
            <input type="date" name="from" defaultValue={filter.from} onChange={applyOnChange} className={FIELD} />
          </Field>
          <Field label={f.to}>
            <input type="date" name="to" defaultValue={filter.to} onChange={applyOnChange} className={FIELD} />
          </Field>
          <Field label={r.filterStatus}>
            <select name="status" defaultValue={filter.status} onChange={applyOnChange} className={`${FIELD} w-24`}>
              <option value="">{f.statuses[0]}</option>
              {REQUEST_STATUSES.map((status, index) => (
                <option key={status} value={status}>
                  {f.statuses[index + 1]}
                </option>
              ))}
            </select>
          </Field>
          <Field label={f.entrypoint}>
            <select
              name="entrypoint"
              defaultValue={filter.entrypoint}
              onChange={applyOnChange}
              className={`${FIELD} w-24`}
            >
              <option value="">{f.allEntrypoints}</option>
              {REQUEST_ENTRYPOINTS.map((entrypoint) => (
                <option key={entrypoint} value={entrypoint}>
                  {f.entrypoints[entrypoint]}
                </option>
              ))}
            </select>
          </Field>
          <Field label={f.library}>
            <select
              name="library"
              defaultValue={filter.library}
              onChange={applyOnChange}
              className={`${FIELD} max-w-[180px]`}
            >
              <option value="">{f.allLibraries}</option>
              {libraries.map((library) => (
                <option key={library.publicId} value={library.publicId}>
                  {library.title}
                </option>
              ))}
            </select>
          </Field>
          <button
            type="submit"
            className="h-[26px] rounded-md border border-line bg-card px-2.5 text-[10px] text-steel hover:bg-subtle"
          >
            {f.apply}
          </button>
          <Link
            href="/dashboard/requests"
            className="inline-flex h-[26px] items-center rounded-md px-2 text-[10px] text-muted hover:text-ink"
          >
            {f.reset}
          </Link>
          {/* Plain anchor, not Link: a CSV is a download, not a navigation. */}
          <a
            href={exportHref}
            className="inline-flex h-[26px] items-center rounded-md bg-brand px-2.5 text-[10px] font-medium text-white hover:bg-brand/90"
          >
            {r.exportCsv}
          </a>
        </div>
      </form>

      <div className="overflow-x-auto">
        <div className="min-w-[700px]">
          <div
            className={`${GRID} bg-subtle px-[18px] py-3 text-[11px] text-muted`}
          >
            {r.columns.map((column) => (
              <span key={column}>{column}</span>
            ))}
            <span>{f.tokensColumn}</span>
          </div>

          {entries.map((entry) => (
            <div
              key={entry.id}
              className={`${GRID} border-t border-line px-[18px] py-3.5 transition-colors hover:bg-subtle`}
            >
              <span className="flex flex-col gap-1">
                <span className="text-[12px] font-medium text-steel">
                  {entry.time}
                </span>
                <span className="font-mono text-[10px] text-muted">{entry.requestId.slice(0, 14)}</span>
              </span>
              <span className="flex min-w-0 flex-col gap-1">
                <span className="truncate text-[11px] text-steel">
                  {entry.operation}
                </span>
                <span className="text-[10px] text-muted">{entry.surface}</span>
              </span>
              <span className="truncate text-[12px] text-steel">
                {entry.library}
              </span>
              <code className="truncate font-mono text-[10.5px] text-steel">
                {entry.key}
              </code>
              <StatusPill status={entry.status} />
              <span className="text-[11px] text-steel">{entry.latency}</span>
              <span className="text-[11px] text-steel">{entry.tokens}</span>
            </div>
          ))}

          {entries.length === 0 ? (
            <p className="border-t border-line px-[18px] py-10 text-center text-[13px] text-muted">
              {r.empty}
            </p>
          ) : null}
        </div>
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-[18px] py-3">
        <p className="text-[11px] text-muted">
          {fill(r.countLine, {
            shown: entries.length,
            total: total.toLocaleString('en-US'),
          })}
        </p>
        <nav className="flex items-center gap-2 text-[11px] text-steel">
          {page > 1 ? (
            <Link href={previousHref} className="rounded-md border border-line bg-card px-2.5 py-1 hover:bg-subtle">
              {r.previous}
            </Link>
          ) : (
            <span className="rounded-md border border-line bg-card px-2.5 py-1 opacity-50">
              {r.previous}
            </span>
          )}
          <span className="text-muted">{fill(f.pageLine, { page, pages: pageCount })}</span>
          {page < pageCount ? (
            <Link href={nextHref} className="rounded-md border border-line bg-card px-2.5 py-1 hover:bg-subtle">
              {r.next}
            </Link>
          ) : (
            <span className="rounded-md border border-line bg-card px-2.5 py-1 opacity-50">
              {r.next}
            </span>
          )}
        </nav>
      </footer>
    </section>
  );
}
