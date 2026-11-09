'use client';

import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useNavigationRouter as useRouter } from '@/components/shell/navigation-provider';
import type { FormEvent } from 'react';
import { LIST_PAGE_SIZES } from '@/lib/constants';
import { useI18n } from '@/i18n/client';
import type { FilterSelect } from '@/components/statistics/filter-form';
import { StatIcon } from '@/components/statistics/owner/icons';

/**
 * The detail tables' filter row on the owner's statistics pages, in the
 * prototype's markup (`.creator-detail-filters`, dot-statistics.js and
 * workspace-details.js `toolbar`): search, selects, a fixed note, rows per
 * page, apply and reset. Same behaviour as components/statistics/filter-form.tsx
 * (which the console keeps): it writes into the current pathname and query,
 * so the period stays as it is, and the page goes back to 1.
 */
export function OwnerFilters({
  search,
  selects,
  fixed,
  fixedIcon = false,
  size,
  resetKeys,
}: {
  search: { value: string; placeholder: string; label: string };
  selects: FilterSelect[];
  fixed?: string;
  /** The prototype's check mark before the fixed note (`/workspace/answers`). */
  fixedIcon?: boolean;
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
    <form key={`${search.value}|${selects.map((select) => select.value).join('|')}|${size}`} onSubmit={submit} className="creator-detail-filters">
      <div className="creator-detail-search">
        <StatIcon name="search" />
        <input type="search" name="q" aria-label={search.label} placeholder={search.placeholder} defaultValue={search.value} maxLength={200} />
      </div>
      {selects.map((select) => (
        <label key={select.name}>
          <span>{select.label}</span>
          <select name={select.name} aria-label={select.label} defaultValue={select.value}>
            {select.options.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      ))}
      {fixed && (
        <span className="creator-detail-fixed">
          {fixedIcon && <StatIcon name="check" />}
          {fixed}
        </span>
      )}
      <label>
        <span>{d.size}</span>
        <select name="size" aria-label={d.size} defaultValue={String(size)}>
          {LIST_PAGE_SIZES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className="btn secondary sm">
        {d.apply}
      </button>
      <Link href={at(reset)} className="text-link">
        {d.reset}
      </Link>
    </form>
  );
}
