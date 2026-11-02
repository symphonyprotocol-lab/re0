/**
 * The console's list pieces (prototype admin-records.js / admin-records.css):
 * page head with breadcrumbs, clickable summary cards, the scrollable table,
 * numbered pages with a jump box, tags and role badges. Server components;
 * the interactive bits live in `list-client.tsx`.
 */
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { Messages } from '@/i18n';
import { fill } from '@/i18n/format';
import { Icon } from '@/components/ui/icons';
import { PageJump } from '@/components/admin/list-client';

export interface Crumb {
  label: string;
  href?: string;
}

export function PageHead({ crumbs, title, lede, actions }: { crumbs?: Crumb[]; title: ReactNode; lede?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6">
      {crumbs && crumbs.length > 0 && (
        <nav aria-label="breadcrumb" className="mb-3 flex min-w-0 flex-wrap items-center gap-1.5 text-[12px] text-muted">
          {crumbs.map((crumb, index) => (
            <span key={`${crumb.label}-${index}`} className="flex min-w-0 items-center gap-1.5">
              {index > 0 && <Icon name="chevronRight" className="size-3 flex-none text-[#a3a9bb]" />}
              {crumb.href ? (
                <Link href={crumb.href} className="max-w-[220px] truncate hover:text-blue">
                  {crumb.label}
                </Link>
              ) : (
                <span className="max-w-[260px] truncate font-semibold text-ink" aria-current="page">
                  {crumb.label}
                </span>
              )}
            </span>
          ))}
        </nav>
      )}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[24px] font-extrabold tracking-tight break-words">{title}</h1>
          {lede && <p className="mt-1.5 text-[13px] text-muted">{lede}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

export function SummaryCards({ items }: { items: { label: string; value: ReactNode; href?: string; active?: boolean; title?: string }[] }) {
  return (
    <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
      {items.map((item) => {
        const body = (
          <>
            <span className="block truncate text-[11px] font-semibold text-muted">{item.label}</span>
            <strong className="mt-1 block font-mono text-[20px] leading-tight">{item.value}</strong>
          </>
        );
        const cls = `card block min-w-0 px-4 py-3 ${item.active ? 'border-blue bg-soft' : ''}`;
        return item.href ? (
          <Link key={item.label} href={item.href} className={`${cls} transition hover:border-[#c4cce0]`} title={item.title} aria-current={item.active ? 'true' : undefined}>
            {body}
          </Link>
        ) : (
          <div key={item.label} className={cls}>
            {body}
          </div>
        );
      })}
    </div>
  );
}

/**
 * A wide table that scrolls inside its card (prototype admin-records.css
 * `.record-table`): at most about a viewport tall, with the header row stuck
 * to the top and, for lists whose last column holds the row's actions
 * (`actions`), that column stuck to the right while the rest scrolls sideways.
 */
export function RecordsTable({ head, rows, empty, label, actions = false }: { head: ReactNode[]; rows: ReactNode[][]; empty: string; label: string; actions?: boolean }) {
  const last = head.length - 1;
  const stuck = (column: number) => actions && column === last;
  return (
    <div className="max-h-[max(190px,calc(100dvh-280px))] max-w-full overflow-auto overscroll-contain" role="region" aria-label={label} tabIndex={0}>
      <table className="w-full min-w-[720px] border-separate border-spacing-0 text-left text-[12px]">
        <thead>
          <tr className="text-[11px] text-muted">
            {head.map((cell, index) => (
              <th key={index} scope="col" className={`sticky top-0 border-b border-line bg-wash px-4 py-2.5 font-semibold whitespace-nowrap ${stuck(index) ? 'right-0 z-[3] border-l' : 'z-[2]'}`}>
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={head.length} className="px-4 py-12 text-center text-[12px] text-muted">
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((row, index) => (
              <tr key={index} className="group align-top">
                {row.map((cell, column) => (
                  <td key={column} className={`border-line bg-white px-4 py-3 group-hover:bg-[#f8fbff] ${index < rows.length - 1 ? 'border-b' : ''} ${stuck(column) ? 'sticky right-0 z-[1] border-l' : ''}`}>
                    {cell}
                  </td>
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

export function LinkPager({ t, page, total, size, href }: { t: Messages; page: number; total: number; size: number; href: (page: number) => string }) {
  const l = t.console.list;
  const pages = Math.max(1, Math.ceil(total / size));
  const cell = 'inline-flex size-8 items-center justify-center rounded-lg text-[12px]';
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3 text-[12px] text-muted">
      <span>{fill(l.page, { page, pages })}</span>
      <nav aria-label={l.pagination} className="flex flex-wrap items-center gap-1">
        {page > 1 ? (
          <Link href={href(page - 1)} className={`${cell} hover:bg-soft`} aria-label={l.previous}>
            <Icon name="chevronLeft" className="size-4" />
          </Link>
        ) : (
          <span className={`${cell} opacity-40`} aria-disabled="true">
            <Icon name="chevronLeft" className="size-4" />
          </span>
        )}
        {pageNumbers(page, pages).map((value, index) =>
          value === null ? (
            <span key={`gap-${index}`} className={cell}>
              …
            </span>
          ) : value === page ? (
            <span key={value} className={`${cell} bg-blue font-semibold text-white`} aria-current="page">
              {value}
            </span>
          ) : (
            <Link key={value} href={href(value)} className={`${cell} text-ink hover:bg-soft`}>
              {value}
            </Link>
          ),
        )}
        {page < pages ? (
          <Link href={href(page + 1)} className={`${cell} hover:bg-soft`} aria-label={l.next}>
            <Icon name="chevronRight" className="size-4" />
          </Link>
        ) : (
          <span className={`${cell} opacity-40`} aria-disabled="true">
            <Icon name="chevronRight" className="size-4" />
          </span>
        )}
      </nav>
      <PageJump page={page} pages={pages} />
    </div>
  );
}

export function ResultsLine({ t, total, page, size, exportHref }: { t: Messages; total: number; page: number; size: number; exportHref?: string }) {
  const from = total ? (page - 1) * size + 1 : 0;
  const to = Math.min(page * size, total);
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5 text-[12px] text-muted" role="status" aria-live="polite">
      <span>{fill(t.console.list.total, { total, from, to })}</span>
      {exportHref && (
        <a href={exportHref} className="text-link text-[12px]" title={t.console.list.exportHint} download>
          <Icon name="download" className="size-3.5" />
          {t.console.list.export}
        </a>
      )}
    </div>
  );
}

const TONES = {
  green: 'border-[#cde8df] bg-[#effaf6] text-green',
  red: 'border-[#f1d4d4] bg-[#fff3f3] text-red',
  orange: 'border-[#f0dcc2] bg-[#fff7ec] text-orange',
  blue: 'border-[#cfe1fb] bg-soft text-blue',
  grey: '',
} as const;

export function Tag({ tone = 'grey', children }: { tone?: keyof typeof TONES; children: ReactNode }) {
  return <span className={`tag whitespace-nowrap ${TONES[tone]}`}>{children}</span>;
}

/** The role badge the console shows next to a user (step 4 renders the product's own). */
export function RoleBadge({ t, role, showNormal = false }: { t: Messages; role: 'normal' | 'verified' | 'official'; showNormal?: boolean }) {
  if (role === 'normal' && !showNormal) return null;
  const tone = role === 'official' ? 'blue' : role === 'verified' ? 'green' : 'grey';
  return (
    <span title={fill(t.console.roleBadge, { role: t.console.roles[role] })}>
      <Tag tone={tone}>
        {role !== 'normal' && <Icon name={role === 'official' ? 'globe' : 'shield'} className="size-3" />}
        {t.console.roles[role]}
      </Tag>
    </span>
  );
}

/** A label above a value, for detail pages. */
export function Fields({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
      {items.map(([label, value], index) => (
        <div key={index} className="min-w-0">
          <dt className="text-[11px] text-muted">{label}</dt>
          <dd className="mt-0.5 text-[13px] break-words">{value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}
