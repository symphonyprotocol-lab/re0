'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { FormEvent } from 'react';
import { LIST_PAGE_SIZES } from '@/lib/constants';
import { useI18n } from '@/i18n/client';
import { Icon } from '@/components/ui/icons';

export interface FilterSelect {
  name: string;
  label: string;
  value: string;
  options: [string, string][];
}

/**
 * The detail tables' filter row (prototype `creator-detail-filters`):
 * search, selects, a fixed note, rows per page, apply and reset. It writes
 * into the current pathname and query, so the period and any parameter the
 * page keeps (the console's `tab`, `from`) stay as they are; the page goes
 * back to 1.
 */
export function FilterForm({
  search,
  selects,
  fixed,
  size,
  resetKeys,
}: {
  search: { value: string; placeholder: string; label: string };
  selects: FilterSelect[];
  fixed?: string;
  size: number;
  /** What "reset" clears besides `q` and `page`. */
  resetKeys?: string[];
}) {
  const { t } = useI18n();
  const d = t.statistics.detail;
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const at = (query: URLSearchParams) => (query.toString() ? `${pathname}?${query}` : pathname);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const query = new URLSearchParams(params.toString());
    query.delete('page');
    const q = String(form.get('q') ?? '').trim();
    if (q) query.set('q', q);
    else query.delete('q');
    for (const select of selects) query.set(select.name, String(form.get(select.name) ?? select.value));
    query.set('size', String(form.get('size') ?? size));
    router.push(at(query));
  };
  const reset = new URLSearchParams(params.toString());
  for (const key of ['q', 'page', ...(resetKeys ?? [])]) reset.delete(key);
  return (
    <form
      key={`${search.value}|${selects.map((select) => select.value).join('|')}|${size}`}
      onSubmit={submit}
      className="flex flex-wrap items-end gap-3 border-b border-line px-4 py-4 md:px-5"
    >
      <label className="flex min-w-0 flex-[1_1_220px] flex-col gap-1">
        <span className="sr-only">{search.label}</span>
        <span className="relative block">
          <Icon name="search" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-[#a3a9bb]" />
          <input type="search" name="q" defaultValue={search.value} placeholder={search.placeholder} maxLength={200} className="input py-2 pl-9" />
        </span>
      </label>
      {selects.map((select) => (
        <label key={select.name} className="flex min-w-0 flex-[0_1_auto] flex-col gap-1">
          <span className="text-[11px] text-muted">{select.label}</span>
          <select name={select.name} defaultValue={select.value} className="input max-w-full py-2 pr-8">
            {select.options.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      ))}
      {fixed && <span className="flex min-h-[38px] items-center rounded-lg bg-wash px-3 text-[12px] text-muted">{fixed}</span>}
      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-muted">{d.size}</span>
        <select name="size" defaultValue={String(size)} className="input py-2 pr-8">
          {LIST_PAGE_SIZES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
      <div className="flex items-center gap-3">
        <button type="submit" className="btn-secondary btn-sm min-h-[38px]">
          {d.apply}
        </button>
        <Link href={at(reset)} className="text-link text-[12px]">
          {d.reset}
        </Link>
      </div>
    </form>
  );
}
