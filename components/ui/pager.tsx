'use client';

import { useI18n } from '@/i18n/client';
import { fill } from '@/i18n/format';
import { Icon } from '@/components/ui/icons';

/** Previous / next with "page / pages" and a page-size select, as in the prototype's lists. */
export function Pager({
  page,
  size,
  total,
  sizes,
  onPage,
  onSize,
}: {
  page: number;
  size: number;
  total: number;
  sizes: readonly number[];
  onPage: (page: number) => void;
  onSize: (size: number) => void;
}) {
  const { t } = useI18n();
  const pages = Math.max(1, Math.ceil(total / size));
  const from = total ? (page - 1) * size + 1 : 0;
  const to = Math.min(page * size, total);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 text-[12px] text-muted">
      <span>{total ? fill(t.common.pager.range, { from, to, total }) : t.common.pager.empty}</span>
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1.5">
          {t.common.pager.perPage}
          <select
            className="rounded-md border border-line bg-white px-2 py-1 text-[12px] text-ink"
            value={size}
            onChange={(event) => onSize(Number(event.target.value))}
          >
            {sizes.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="icon-btn" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label={t.common.pager.previous}>
          <Icon name="chevronLeft" />
        </button>
        <span className="font-mono text-ink">
          {page} / {pages}
        </span>
        <button type="button" className="icon-btn" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label={t.common.pager.next}>
          <Icon name="chevronRight" />
        </button>
      </div>
    </div>
  );
}
