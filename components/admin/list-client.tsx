'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useState, type FormEvent, type ReactNode } from 'react';
import { api } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { fill } from '@/i18n/format';
import { CI, type ConsoleIconName } from '@/components/admin/console-icon';
import { Modal } from '@/components/admin/console-modal';

/** The URL with `changes` applied: a default value drops its key, and any filter change goes back to page 1. */
function useNavigate(defaults: Record<string, string>) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  return (changes: Record<string, string>) => {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value === '' || value === defaults[key]) next.delete(key);
      else next.set(key, value);
    }
    if (Object.keys(changes).some((key) => key !== 'page')) next.delete('page');
    const query = next.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  };
}

export interface FilterSelect {
  name: string;
  label: string;
  /** The select's accessible name when it differs from the visible label. */
  aria?: string;
  value: string;
  options: [string, string][];
}

/**
 * A list's filter bar (prototype admin-records.js `#admin-record-filter`):
 * the search box applies on submit, every select as soon as it changes; the
 * state lives in the URL, so reload and back / forward restore it. A select
 * named `size` sits last as the per-page choice (`.record-size`). The users
 * list (`variant="users"`) puts search, reset and size on one row and the
 * criteria on a second (`.record-user-filter`).
 */
export function ListFilters({
  q,
  placeholder,
  selects,
  defaults,
  resetHref,
  filtered,
  queryName = 'q',
  variant = 'records',
  formId = 'admin-record-filter',
  className = 'record-filter',
  sizeClassName = 'record-size',
  resetClassName = 'text-link',
  searchLabel,
  children,
}: {
  q: string;
  placeholder: string;
  selects: FilterSelect[];
  defaults: Record<string, string>;
  resetHref: string;
  filtered: boolean;
  queryName?: string;
  variant?: 'records' | 'users';
  formId?: string;
  className?: string;
  /** The per-page label's class (`.record-size`, `.admin-ree-size`). */
  sizeClassName?: string;
  resetClassName?: string;
  /** The search box's accessible name, when it differs from the list's default. */
  searchLabel?: string;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const l = t.console.list;
  const navigate = useNavigate(defaults);
  const select = (item: FilterSelect, cls?: string) => (
    <label key={item.name} className={cls}>
      <span>{item.label}</span>
      <select name={item.name} value={item.value} aria-label={item.aria ?? item.label} onChange={(event) => navigate({ [item.name]: event.target.value })}>
        {item.options.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
  const size = selects.find((item) => item.name === 'size');
  const criteria = selects.filter((item) => item.name !== 'size');
  const search = (
    <div className="search-small">
      <CI name="search" />
      <input key={q} name={queryName} defaultValue={q} maxLength={400} aria-label={searchLabel ?? l.searchLabel} placeholder={placeholder} />
    </div>
  );
  const submit = <button className="btn secondary sm">{l.search}</button>;
  const reset = filtered && (
    <Link className={resetClassName} href={resetHref}>
      {l.reset}
    </Link>
  );
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    navigate({ [queryName]: String(new FormData(event.currentTarget).get(queryName) ?? '').trim() });
  };
  if (variant === 'users')
    return (
      <form id={formId} className="record-filter record-user-filter" onSubmit={onSubmit}>
        <div className="record-user-search">
          {search}
          {submit}
          {reset}
          {size && select(size)}
        </div>
        <div className="record-user-criteria">{criteria.map((item) => select(item))}</div>
        {children}
      </form>
    );
  return (
    <form id={formId} className={className} onSubmit={onSubmit}>
      {search}
      {criteria.map((item) => select(item))}
      {submit}
      {reset}
      {children}
      {size && select(size, sizeClassName)}
    </form>
  );
}

/** "跳至 [n] 跳转" (`#admin-record-jump`): an out-of-range number is pulled back by the list itself. */
export function PageJump({ page, pages, name = 'page', formId = 'admin-record-jump' }: { page: number; pages: number; name?: string; formId?: string }) {
  const { t } = useI18n();
  const l = t.console.list;
  const navigate = useNavigate({});
  const inputId = `${formId}-${name}`;
  return (
    <form
      id={formId}
      onSubmit={(event) => {
        event.preventDefault();
        const value = Number(new FormData(event.currentTarget).get('page'));
        if (Number.isInteger(value) && value >= 1) navigate({ [name]: String(Math.min(value, pages)) });
      }}
    >
      <label htmlFor={inputId}>{l.goTo}</label>
      <input id={inputId} key={page} name="page" type="number" min={1} max={pages} defaultValue={page} aria-label={l.pageNumber} required disabled={pages === 1} />
      <button className="btn secondary sm" disabled={pages === 1}>
        {l.go}
      </button>
    </form>
  );
}

/** "导出筛选结果": downloads the CSV of every row that matches the filters. */
export function ExportButton({ href }: { href: string }) {
  const { t } = useI18n();
  return (
    <button type="button" className="text-link" title={t.console.list.exportHint} onClick={() => window.location.assign(href)}>
      <CI name="external" />
      {t.console.list.export}
    </button>
  );
}

/**
 * A button that opens a dialog asking for a reason (and whatever extra
 * fields the action takes), posts it, and refreshes the page. Error codes
 * from the endpoint are shown through `errors`, falling back to the
 * console's shared messages.
 */
export function ReasonAction({
  endpoint,
  method = 'POST',
  label,
  title,
  subtitle,
  body,
  confirmLabel,
  reason = { min: 3, max: 300, required: true },
  payload = {},
  errors = {},
  danger = false,
  className = 'btn secondary sm',
  icon,
  onDone,
  children,
}: {
  endpoint: string;
  method?: 'POST' | 'PUT';
  label: ReactNode;
  title: string;
  subtitle?: string;
  body?: ReactNode;
  confirmLabel: string;
  reason?: { min: number; max: number; required: boolean; label?: string };
  payload?: Record<string, unknown>;
  errors?: Record<string, string>;
  danger?: boolean;
  className?: string;
  icon?: ConsoleIconName;
  onDone?: (data: unknown) => void;
  /** Extra form fields, read with FormData and sent along. */
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const c = t.console;
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const formId = `reason-${endpoint.replace(/\W+/g, '-')}`;
  return (
    <>
      <button type="button" className={className} onClick={() => (setError(''), setOpen(true))}>
        {icon && <CI name={icon} />}
        {label}
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={title}
        subtitle={subtitle}
        footer={
          <>
            <button type="button" className="btn secondary" onClick={() => setOpen(false)}>
              {t.common.actions.cancel}
            </button>
            <button type="submit" form={formId} className={`btn ${danger ? 'danger' : ''}`} disabled={busy}>
              {busy && <span className="spinner" aria-hidden="true" />}
              {confirmLabel}
            </button>
          </>
        }
      >
        <form
          id={formId}
          onSubmit={async (event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const text = String(form.get('reason') ?? '').trim();
            const length = Array.from(text).length;
            if ((reason.required || text) && (length < reason.min || length > reason.max)) {
              setError(fill(c.reason.invalid, { min: reason.min, max: reason.max }));
              return;
            }
            const extra: Record<string, unknown> = {};
            for (const [key, value] of form.entries()) if (key !== 'reason') extra[key] = value;
            setBusy(true);
            setError('');
            const result = await api<{ error?: string }>(endpoint, { method, json: { ...payload, ...extra, reason: text } });
            setBusy(false);
            if (!result.ok) {
              const code = result.data.error ?? '';
              setError(errors[code] ?? (c.errors as Record<string, string>)[code] ?? c.errors.generic);
              return;
            }
            setOpen(false);
            onDone?.(result.data);
            router.refresh();
          }}
        >
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          {children}
          <div className="field">
            <label htmlFor={`${formId}-reason`}>{reason.label ?? c.reason.required}</label>
            <textarea id={`${formId}-reason`} name="reason" rows={3} minLength={reason.required ? reason.min : undefined} maxLength={reason.max} required={reason.required} />
            <small>{fill(c.reason.hint, { min: reason.min, max: reason.max })}</small>
          </div>
          {body && <p className="form-hint">{body}</p>}
        </form>
      </Modal>
    </>
  );
}
