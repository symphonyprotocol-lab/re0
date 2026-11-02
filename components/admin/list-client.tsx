'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { api } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { fill } from '@/i18n/format';
import { Icon, Spinner } from '@/components/ui/icons';
import { Modal } from '@/components/ui/modal';

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
  value: string;
  options: [string, string][];
}

/**
 * A list's filter bar (prototype `#admin-record-filter`): the search box
 * applies on submit, every select as soon as it changes; the state lives in
 * the URL, so reload and back / forward restore it.
 */
export function ListFilters({
  q,
  placeholder,
  selects,
  defaults,
  resetHref,
  filtered,
  queryName = 'q',
  children,
}: {
  q: string;
  placeholder: string;
  selects: FilterSelect[];
  defaults: Record<string, string>;
  resetHref: string;
  filtered: boolean;
  queryName?: string;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const l = t.console.list;
  const navigate = useNavigate(defaults);
  const router = useRouter();
  return (
    <form
      className="flex flex-wrap items-end gap-3 border-b border-line px-4 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        navigate({ [queryName]: String(new FormData(event.currentTarget).get(queryName) ?? '').trim() });
      }}
    >
      <label className="flex min-w-[200px] flex-[1_1_240px] items-center gap-2 rounded-lg border border-line bg-white px-3 focus-within:border-blue">
        <Icon name="search" className="size-4 flex-none text-muted" />
        <input
          key={q}
          name={queryName}
          defaultValue={q}
          maxLength={400}
          type="search"
          placeholder={placeholder}
          aria-label={placeholder}
          className="min-w-0 flex-1 bg-transparent py-2 text-[13px] outline-none"
        />
      </label>
      {selects.map((select) => (
        <label key={select.name} className="flex min-w-0 flex-col gap-1 text-[11px] font-semibold text-muted">
          {select.label}
          <select
            className="max-w-[200px] rounded-lg border border-line bg-white px-2.5 py-2 text-[12px] font-normal text-ink"
            value={select.value}
            aria-label={select.label}
            onChange={(event) => navigate({ [select.name]: event.target.value })}
          >
            {select.options.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      ))}
      <button type="submit" className="btn-secondary btn-sm">
        {l.search}
      </button>
      {filtered && (
        <button type="button" className="text-link text-[12px]" onClick={() => router.push(resetHref)}>
          {l.reset}
        </button>
      )}
      {children}
    </form>
  );
}

/** "跳至 [n] 跳转": an out-of-range number is pulled back by the list itself. */
export function PageJump({ page, pages, name = 'page' }: { page: number; pages: number; name?: string }) {
  const { t } = useI18n();
  const l = t.console.list;
  const navigate = useNavigate({});
  return (
    <form
      className="flex items-center gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        const value = Number(new FormData(event.currentTarget).get('page'));
        if (Number.isInteger(value) && value >= 1) navigate({ [name]: String(Math.min(value, pages)) });
      }}
    >
      <label htmlFor={`jump-${name}`}>{l.goTo}</label>
      <input
        id={`jump-${name}`}
        key={page}
        name="page"
        type="number"
        min={1}
        max={pages}
        defaultValue={page}
        aria-label={l.pageNumber}
        disabled={pages === 1}
        className="w-16 rounded-lg border border-line bg-white px-2 py-1 text-[12px] text-ink"
      />
      <button type="submit" className="btn-secondary btn-sm" disabled={pages === 1}>
        {l.go}
      </button>
    </form>
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
  className = 'btn-secondary btn-sm',
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
  icon?: Parameters<typeof Icon>[0]['name'];
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
        {icon && <Icon name={icon} className="size-3.5" />}
        {label}
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={title}
        subtitle={subtitle}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>
              {t.common.actions.cancel}
            </button>
            <button type="submit" form={formId} className={danger ? 'btn-danger' : 'btn'} disabled={busy}>
              {busy && <Spinner />}
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
          {body && <div className="mb-4 text-[13px] leading-relaxed text-muted">{body}</div>}
          {children}
          <label htmlFor={`${formId}-reason`} className="field-label">
            {reason.label ?? c.reason.required}
          </label>
          <textarea id={`${formId}-reason`} name="reason" rows={4} maxLength={reason.max} required={reason.required} className="input resize-y" />
          <small className="hint">{fill(c.reason.hint, { min: reason.min, max: reason.max })}</small>
          {error && (
            <p role="alert" className="mt-3 text-[12px] text-red">
              {error}
            </p>
          )}
        </form>
      </Modal>
    </>
  );
}
