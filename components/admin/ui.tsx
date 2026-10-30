import Link from 'next/link';
import type { ReactNode } from 'react';
import { ChevronLeftIcon, ChevronRightIcon, DownloadIcon, SearchIcon } from '@/components/ui/icons';
import { fill } from '@/lib/i18n/format';

/**
 * Panel chrome shared by every card in the admin design frames.
 *
 * The console draws a flatter card than the dashboard -- 10px corners, no
 * shadow -- so it gets its own constant rather than reusing the dashboard one.
 */
export const CONSOLE_PANEL = 'rounded-[10px] border-2 border-line bg-card';

export function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`${CONSOLE_PANEL} ${className}`}>{children}</section>;
}

/** Eyebrow + title + description, the page header every console screen opens with. */
export function ConsolePageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex max-w-[520px] flex-col gap-[4.5px]">
        <p className="text-[11px] font-bold tracking-[0.05em] text-brand">{eyebrow}</p>
        <h1 className="text-[25px] leading-[1.4] font-[650] tracking-[-0.045em] text-ink">
          {title}
        </h1>
        <p className="text-[13px] leading-[1.5] tracking-[-0.023em] text-muted">{description}</p>
      </div>
      {action}
    </header>
  );
}

/** Title row that sits above a panel's body, separated by the design's 2px rule. */
export function PanelHead({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3.5 border-b-2 border-line px-[19px] py-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-[16px] leading-[1.4] tracking-[-0.025em] text-ink">{title}</h2>
        {description ? (
          <p className="text-[12px] leading-[1.5] tracking-[-0.023em] text-muted">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

/**
 * Everything but the height, which `size` decides.
 *
 * Keeping the height out of the base string is not tidiness. A caller passing
 * `h-8` through `className` looks like it works and does not: both utilities
 * end up in the stylesheet, Tailwind orders them by its own rules rather than
 * by the order of the class attribute, and the arbitrary `h-[37px]` is emitted
 * after `h-8` -- so the override loses silently.
 */
const BUTTON_BASE =
  'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-[7px] px-3 text-[12px] font-medium tracking-[-0.023em] transition-colors';

const BUTTON_SIZE = { md: 'h-[37px]', sm: 'h-8' } as const;

export function ConsoleButton({
  children,
  variant = 'outline',
  size = 'md',
  href,
  type = 'button',
  className = '',
  disabled,
  onClick,
  form,
}: {
  children: ReactNode;
  variant?: 'primary' | 'outline' | 'ghost';
  /** `sm` is the 32px control the design draws inside cards. */
  size?: 'md' | 'sm';
  href?: string;
  type?: 'button' | 'submit';
  className?: string;
  disabled?: boolean;
  /** Client components only -- a server component cannot pass a handler. */
  onClick?: () => void;
  /** Submits a form this button sits outside of, e.g. a dialog footer. */
  form?: string;
}) {
  const style =
    variant === 'primary'
      ? 'bg-brand text-white hover:bg-brand/90'
      : variant === 'ghost'
        ? 'text-steel hover:bg-subtle'
        : 'border-2 border-line bg-card text-steel hover:bg-subtle';
  const merged = `${BUTTON_BASE} ${BUTTON_SIZE[size]} ${style} disabled:opacity-60 ${className}`;
  return href ? (
    <Link href={href} className={merged}>
      {children}
    </Link>
  ) : (
    <button type={type} className={merged} disabled={disabled} onClick={onClick} form={form}>
      {children}
    </button>
  );
}

const ICON_CONTROL =
  'inline-flex size-[30px] shrink-0 items-center justify-center rounded-[6px] border-2 border-line bg-card text-muted transition-colors hover:bg-subtle hover:text-steel disabled:opacity-50 disabled:hover:bg-card';

/** 30px square action button, the per-row control the design puts in tables. */
export function IconButton({
  label,
  children,
  onClick,
  disabled,
}: {
  label: string;
  children: ReactNode;
  /** Client components only -- a server component cannot pass a handler. */
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={ICON_CONTROL}
    >
      {children}
    </button>
  );
}

/** The same 30px control as a link, for a row action that is a navigation. */
export function IconLink({
  label,
  href,
  children,
}: {
  label: string;
  href: string;
  children: ReactNode;
}) {
  return (
    <Link href={href} aria-label={label} title={label} className={ICON_CONTROL}>
      {children}
    </Link>
  );
}

/**
 * Toolbar above a list: search on the left, filters and exports on the right.
 *
 * With `name`, the field is a real query parameter and the surrounding form
 * submits it; without one it stays presentational, which is still the case for
 * the lists whose endpoints do not exist yet (architecture.md 21).
 */
export function ListToolbar({
  placeholder,
  children,
  name,
  defaultValue,
}: {
  placeholder: string;
  children?: ReactNode;
  /** Set on lists whose search is served; left off it stays presentational. */
  name?: string;
  defaultValue?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b-2 border-line px-[15px] py-3">
      <label className="flex h-[37px] min-w-[220px] flex-1 items-center gap-2 rounded-[7px] border-2 border-line bg-[#fbfefe] px-3">
        <SearchIcon size={15} className="text-muted" />
        <input
          type="search"
          name={name}
          defaultValue={defaultValue}
          placeholder={placeholder}
          className="min-w-0 flex-1 bg-transparent text-[13px] tracking-[-0.023em] text-ink placeholder:text-ink/50 focus:outline-none"
        />
      </label>
      {children}
    </div>
  );
}

export interface ConsoleTab {
  id: string;
  label: string;
  count?: number;
  /** Tabs without an href are filters the list endpoint does not serve yet. */
  href?: string;
}

/** Underlined filter tabs above a list -- design source `zcHnx`, `z9DJOF`. */
export function TabBar({ tabs, activeId }: { tabs: ConsoleTab[]; activeId: string }) {
  return (
    <nav className="flex flex-wrap items-end gap-1 border-b-2 border-line">
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        const body = (
          <>
            {tab.label}
            {tab.count === undefined ? null : (
              <span className="text-[11px] text-muted">{tab.count}</span>
            )}
          </>
        );
        const className = `-mb-0.5 inline-flex h-[35px] items-center gap-1.5 border-b-2 px-[11px] text-[12px] tracking-[-0.023em] transition-colors ${
          active
            ? 'border-brand text-brandink'
            : 'border-transparent text-muted hover:text-steel'
        }`;
        return tab.href && !active ? (
          <Link key={tab.id} href={tab.href} className={className}>
            {body}
          </Link>
        ) : (
          <span key={tab.id} aria-current={active ? 'page' : undefined} className={className}>
            {body}
          </span>
        );
      })}
    </nav>
  );
}

type PillTone = 'ok' | 'warn' | 'danger' | 'neutral' | 'brand' | 'info';

const PILL_TONE: Record<PillTone, string> = {
  ok: 'bg-pubsoft text-pubink',
  warn: 'bg-ambersoft text-amberink',
  danger: 'bg-rosesoft text-err',
  neutral: 'bg-mutedbg text-steel',
  brand: 'bg-brandsoft text-brandink',
  info: 'bg-infosoft text-infoink',
};

export function Pill({ tone = 'neutral', children }: { tone?: PillTone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-[7px] py-1 text-[11px] font-semibold whitespace-nowrap ${PILL_TONE[tone]}`}
    >
      {children}
    </span>
  );
}

/** Monogram tile beside a person or asset name in the console tables. */
export function Monogram({
  initial,
  tone = 'mint',
}: {
  initial: string;
  tone?: 'mint' | 'ink';
}) {
  return (
    <span
      aria-hidden
      className={`flex size-[34px] shrink-0 items-center justify-center rounded-[8px] text-[12px] font-semibold ${
        tone === 'ink' ? 'bg-console text-white' : 'bg-brandsoft text-brandink'
      }`}
    >
      {initial}
    </span>
  );
}

/** Two-line cell: a name over its identifier, as every console table draws it. */
export function TitleCell({
  title,
  meta,
  leading,
}: {
  title: string;
  meta: string;
  leading?: ReactNode;
}) {
  return (
    <span className="flex items-center gap-2.5">
      {leading}
      <span className="flex min-w-0 flex-col gap-[3px]">
        <span className="truncate text-[12px] leading-[1.4] font-medium tracking-[-0.023em] text-ink">
          {title}
        </span>
        <span className="truncate text-[11px] leading-[1.4] tracking-[-0.023em] text-muted">
          {meta}
        </span>
      </span>
    </span>
  );
}

/** Column head and body cell classes, so every console table lines up. */
export const TH =
  'bg-subtle px-[15px] py-[11px] text-left text-[11px] font-bold tracking-[0.02em] whitespace-nowrap text-faint';
export const TD = 'px-[15px] py-3.5 text-[12px] tracking-[-0.023em] text-steel align-middle';

/**
 * Download control for a console list.
 *
 * A link, not a button: it carries the list's own filters so the file matches
 * what is on screen, and `/admin/export` re-checks the capability rather than
 * trusting that a screen rendered the link.
 */
export function ExportLink({
  resource,
  query,
  status,
  period,
  filters,
  label,
}: {
  resource: string;
  query?: string;
  status?: string;
  /** A settlement period; only that export reads it. */
  period?: string;
  /** Any other filters the list carries, e.g. billing's kind and dates; empty ones are dropped. */
  filters?: Record<string, string | undefined>;
  label: string;
}) {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (status && status !== 'all') params.set('status', status);
  if (period) params.set('period', period);
  for (const [key, value] of Object.entries(filters ?? {})) {
    if (value && value !== 'all') params.set(key, value);
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : '';

  return (
    <a
      href={`/admin/export/${resource}${suffix}`}
      download
      className={`${BUTTON_BASE} ${BUTTON_SIZE.md} border-2 border-line bg-card text-steel hover:bg-subtle`}
    >
      <DownloadIcon size={14} />
      {label}
    </a>
  );
}

/**
 * What a list says when it has nothing to show.
 *
 * `note` is for the lists whose subsystem is not built yet: an operator seeing
 * an empty review queue needs to know whether that means "nothing to do" or
 * "this does not work yet", and only one of those is a reason to go looking.
 */
export function EmptyRow({
  columns,
  message,
  note,
}: {
  columns: number;
  message: string;
  note?: string;
}) {
  return (
    <tr className="border-t-2 border-line">
      <td colSpan={columns} className="px-[15px] py-9 text-center">
        <p className="text-[13px] tracking-[-0.023em] text-steel">{message}</p>
        {note ? <p className="mt-1.5 text-[11px] text-muted">{note}</p> : null}
      </td>
    </tr>
  );
}

/** Horizontal scroller so wide tables never widen the page. */
export function TableScroller({ children }: { children: ReactNode }) {
  return <div className="overflow-x-auto">{children}</div>;
}

/**
 * List footer: the range readout on the left, page controls on the right.
 *
 * A list whose pages are served passes `href`, and the controls become links --
 * so a page of the list is a URL an operator can keep, share or reload. Without
 * it they stay disabled buttons rather than links, so nothing on a screen that
 * still renders fixtures suggests a working page 2.
 */
export function Pagination({
  summary,
  pages,
  activePage,
  labels,
  href,
  pageCount,
}: {
  summary: string;
  pages: number[];
  activePage: number;
  labels: { prev: string; next: string; page: string };
  href?: (page: number) => string;
  /** Needed with `href`, to know whether there is a next page at all. */
  pageCount?: number;
}) {
  const step =
    'inline-flex h-[30px] items-center justify-center rounded-[5px] border-2 border-line bg-card px-2.5 text-[11px] tracking-[-0.023em] text-steel disabled:opacity-50';
  const cell = (page: number) =>
    `inline-flex size-[30px] items-center justify-center rounded-[5px] border-2 text-[11px] tracking-[-0.023em] ${
      page === activePage
        ? 'border-brand bg-brand text-white'
        : 'border-line bg-card text-steel opacity-70'
    }`;

  const last = pageCount ?? activePage;
  const prev = href && activePage > 1 ? href(activePage - 1) : undefined;
  const next = href && activePage < last ? href(activePage + 1) : undefined;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t-2 border-line px-4 py-[11px]">
      <p className="text-[12px] tracking-[-0.023em] text-muted">{summary}</p>
      <div className="flex items-center gap-1">
        {prev ? (
          <Link href={prev} rel="prev" className={`${step} hover:bg-subtle`}>
            <ChevronLeftIcon size={13} />
            {labels.prev}
          </Link>
        ) : (
          <button type="button" disabled className={step}>
            <ChevronLeftIcon size={13} />
            {labels.prev}
          </button>
        )}
        {pages.map((page) =>
          href && page !== activePage ? (
            <Link
              key={page}
              href={href(page)}
              aria-label={fill(labels.page, { page })}
              className={`${cell(page)} hover:bg-subtle`}
            >
              {page}
            </Link>
          ) : (
            <button
              key={page}
              type="button"
              disabled
              aria-current={page === activePage ? 'page' : undefined}
              className={cell(page)}
            >
              {page}
            </button>
          ),
        )}
        {next ? (
          <Link href={next} rel="next" className={`${step} hover:bg-subtle`}>
            {labels.next}
            <ChevronRightIcon size={13} />
          </Link>
        ) : (
          <button type="button" disabled className={step}>
            {labels.next}
            <ChevronRightIcon size={13} />
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Tinted banner for a rule the operator has to know about -- design source
 * `RubCg` and `Uko79`.
 */
export function ConsoleNotice({
  icon,
  title,
  body,
  action,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <section className="flex flex-wrap items-center gap-3.5 rounded-[9px] border-2 border-publine bg-[#f1faf8] px-[17px] py-3.5">
      <span className="flex size-[38px] shrink-0 items-center justify-center rounded-[8px] bg-card text-brand">
        {icon}
      </span>
      <div className="flex min-w-[220px] flex-1 flex-col gap-1">
        <p className="text-[13px] leading-[1.4] font-bold tracking-[-0.023em] text-ink">{title}</p>
        <p className="text-[11px] leading-[1.5] tracking-[-0.023em] text-muted">{body}</p>
      </div>
      {action}
    </section>
  );
}

/**
 * One headline number above a detail screen -- design source `DPlDO`, `DiUMB`.
 *
 * Shared by the console's detail screens rather than copied into each: two
 * screens drawing the same card from two definitions is how a 22px number
 * becomes a 20px one on the screen nobody looked at.
 */
export function Metric({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <Panel className="flex flex-col gap-1.5 px-4 py-3.5">
      <p className="text-[11px] font-bold tracking-[0.02em] text-faint">{label}</p>
      <p className="text-[22px] leading-[1.2] font-[650] tracking-[-0.04em] text-ink">{value}</p>
      <p className="text-[11px] tracking-[-0.023em] text-muted">{note}</p>
    </Panel>
  );
}

/** One labelled fact inside a detail panel's two-column `<dl>`. */
export function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 border-b border-line/70 py-3 last:border-b-0 sm:[&:nth-last-child(-n+2)]:border-b-0">
      <dt className="text-[11px] font-bold tracking-[0.02em] text-faint">{label}</dt>
      <dd className="text-[12px] tracking-[-0.023em] break-all text-steel">{value}</dd>
    </div>
  );
}

/** Progress bar used by the health readouts. */
export function Meter({ value }: { value: number }) {
  return (
    <div className="h-1 overflow-hidden rounded-full bg-mutedbg">
      <div
        className="h-full rounded-full bg-brand"
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  );
}
