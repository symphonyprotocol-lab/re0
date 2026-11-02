/**
 * The console's list and detail pieces, in the prototype's markup (suite.js
 * `sectionHead` / `stats` / `table` / `tag`, admin-records.js `summary`,
 * `pager`, `person`, `fields`), styled by console.css: page head, stat cards,
 * clickable summary cards, the scrolling record table, numbered pages with a
 * jump box, tags and role badges. Server components; the interactive bits
 * live in `list-client.tsx`.
 */
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { Messages } from '@/i18n';
import { fill } from '@/i18n/format';
import { CI, type ConsoleIconName } from '@/components/admin/console-icon';
import { ExportButton, PageJump } from '@/components/admin/list-client';

/** The page's kicker, title, lede and actions (`.page-head`); its breadcrumbs live in the fixed `ConsoleTopbar`. */
export function PageHead({ title, lede, actions, kicker = 'OPERATIONS / RE0' }: { title: ReactNode; lede?: ReactNode; actions?: ReactNode; kicker?: string }) {
  return (
    <div className="page-head">
      <div>
        <p className="eyebrow section-kicker">{kicker}</p>
        <h1>{title}</h1>
        {lede && <p>{lede}</p>}
      </div>
      {actions}
    </div>
  );
}

/** Stat cards (`.suite-stats`): label and icon, the figure, a note. */
export function Stats({ items }: { items: { label: ReactNode; value: ReactNode; note?: ReactNode; icon: ConsoleIconName; href?: string }[] }) {
  return (
    <div className="suite-stats">
      {items.map((item, index) => {
        const body = (
          <>
            <div className="between">
              <span>{item.label}</span>
              <CI name={item.icon} />
            </div>
            <strong className="mono">{item.value}</strong>
            <small>{item.note}</small>
          </>
        );
        return item.href ? (
          <Link key={index} href={item.href} className="card suite-stat">
            {body}
          </Link>
        ) : (
          <article key={index} className="card suite-stat">
            {body}
          </article>
        );
      })}
    </div>
  );
}

/** The full-catalog summary above a list (`.record-summary`); a card with `href` filters, `active` marks the current filter. */
export function SummaryCards({ items, label }: { items: { label: string; value: ReactNode; href?: string; active?: boolean; title?: string }[]; label?: string }) {
  return (
    <div className="record-summary" aria-label={label}>
      {items.map((item) => {
        const body = (
          <>
            <span>{item.label}</span>
            <strong className="mono">{item.value}</strong>
          </>
        );
        return item.href ? (
          <Link
            key={item.label}
            href={item.href}
            className={`record-summary-item ${item.active ? 'is-filtered' : ''}`}
            title={item.title}
            aria-current={item.active ? 'true' : undefined}
          >
            {body}
          </Link>
        ) : (
          <div key={item.label} className="record-summary-item">
            {body}
          </div>
        );
      })}
    </div>
  );
}

/** The card a list sits in (`section.card.record-table`): filters, results line, table, pages. */
export function RecordSection({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`card record-table ${className}`}>{children}</section>;
}

/**
 * A table in its scrolling wrap (suite.js `table`); inside `.record-table` the
 * header row sticks to the top and the last (action) column to the right.
 * An empty list shows the prototype's search icon and message.
 */
export function RecordsTable({ head, rows, empty, label }: { head: ReactNode[]; rows: ReactNode[][]; empty: string; label?: string; actions?: boolean }) {
  return (
    <div className="table-wrap" role="region" aria-label={label} tabIndex={0}>
      <table>
        <thead>
          <tr>
            {head.map((cell, index) => (
              <th key={index} scope="col">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={head.length} className="table-empty">
                <CI name="search" />
                <p>{empty}</p>
              </td>
            </tr>
          ) : (
            rows.map((row, index) => (
              <tr key={index}>
                {row.map((cell, column) => (
                  <td key={column}>{cell}</td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

/** Page numbers around the current one, with gaps: 1 … 4 5 [6] 7 8 … 20. */
export function pageNumbers(page: number, pages: number): (number | null)[] {
  const wanted = new Set([1, pages, page - 2, page - 1, page, page + 1, page + 2].filter((value) => value >= 1 && value <= pages));
  const sorted = [...wanted].sort((a, b) => a - b);
  const result: (number | null)[] = [];
  for (const value of sorted) {
    if (result.length && value - (result[result.length - 1] as number) > 1) result.push(null);
    result.push(value);
  }
  return result;
}

/** "第 n / m 页", the numbered pages and "跳至" (admin-records.js `pager`). */
export function LinkPager({ t, page, total, size, href, jumpId = 'admin-record-jump' }: { t: Messages; page: number; total: number; size: number; href: (page: number) => string; jumpId?: string }) {
  const l = t.console.list;
  const pages = Math.max(1, Math.ceil(total / size));
  const step = (target: number, label: string) =>
    target < 1 || target > pages ? (
      <span className="is-disabled" aria-disabled="true">
        <CI name="chevron" />
      </span>
    ) : (
      <Link href={href(target)} className="record-page-link" aria-label={label}>
        <CI name="chevron" />
      </Link>
    );
  return (
    <div className="admin-ree-pagination record-pagination">
      <span>{fill(l.page, { page, pages })}</span>
      <nav className="admin-ree-pages" aria-label={l.pagination}>
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
            <Link key={value} href={href(value)} className="record-page-link" aria-label={fill(l.pageLabel, { page: value })}>
              {value}
            </Link>
          ),
        )}
        {step(page + 1, l.next)}
      </nav>
      <PageJump page={page} pages={pages} formId={jumpId} />
    </div>
  );
}

/** "共 N 条 · 显示 a–b", a note, and the CSV export (admin-records.js `.record-results`). */
export function ResultsLine({ t, total, page, size, exportHref, note }: { t: Messages; total: number; page: number; size: number; exportHref?: string; note?: ReactNode }) {
  const l = t.console.list;
  const from = total ? (page - 1) * size + 1 : 0;
  const to = Math.min(page * size, total);
  const [before, after] = l.total.split('{total}');
  return (
    <div className="record-results" role="status" aria-live="polite">
      <span>
        {before}
        <strong>{total.toLocaleString('en-US')}</strong>
        {fill(after ?? '', { from, to })}
      </span>
      <small>{note ?? l.note}</small>
      {exportHref && <ExportButton href={exportHref} />}
    </div>
  );
}

const TONES = { green: 'green', red: 'red', orange: 'orange', blue: 'blue', grey: '' } as const;

/** A status tag (suite.js `tag`): tone and, by default, the leading dot. */
export function Tag({ tone = 'grey', dot = true, children }: { tone?: keyof typeof TONES; dot?: boolean; children: ReactNode }) {
  return (
    <span className={`tag ${TONES[tone]}`}>
      {dot && <i className="dot" />}
      {children}
    </span>
  );
}

/** The account-role badge (user-roles.js `badge`). */
export function RoleBadge({ t, role, showNormal = false }: { t: Messages; role: 'normal' | 'verified' | 'official'; showNormal?: boolean }) {
  if (role === 'normal' && !showNormal) return null;
  return (
    <span className={`role-badge role-${role}`} title={fill(t.console.roleBadge, { role: t.console.roles[role] })}>
      {role !== 'normal' && <CI name={role === 'official' ? 'globe' : 'shield'} />}
      {t.console.roles[role]}
    </span>
  );
}

/** A value cut to one line with the whole of it on hover (`.record-clip`). */
export function Clip({ value, className = '' }: { value: ReactNode; className?: string }) {
  const text = value === null || value === undefined || value === '' ? '—' : value;
  return (
    <span className={`record-clip ${className}`} title={typeof text === 'string' || typeof text === 'number' ? String(text) : undefined}>
      {text}
    </span>
  );
}

/** A person in a list (`.record-person`): the name links to the user's page, the email below. */
export function Person({ name, email, href }: { name: string; email?: string | null; href?: string }) {
  return (
    <div className="record-person">
      {href ? (
        <Link className="text-link" href={href}>
          <Clip value={name} className="record-name" />
        </Link>
      ) : (
        <Clip value={name} />
      )}
      <small>
        <Clip value={email} />
      </small>
    </div>
  );
}

/** The row's way into its record (`.record-open`). */
export function OpenLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link className="btn secondary sm record-open" href={href}>
      {children}
    </Link>
  );
}

/** A second line under a cell's value (`.cell-subline`). */
export function Subline({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <small className={`cell-subline ${className}`}>{children}</small>;
}

/** A titled card on a detail page (`.record-detail-section`). */
export function DetailSection({ title, children, className = '' }: { title: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card record-detail-section ${className}`}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

/** Labels beside values (`.record-fields`). */
export function Fields({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="record-fields">
      {items.map(([label, value], index) => (
        <div key={index}>
          <dt>{label}</dt>
          <dd>{value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}
