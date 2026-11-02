import Link from 'next/link';
import type { ReactNode } from 'react';
import { locatorLabel, type CitationSnapshot } from '@/lib/domain/answer';
import type { Messages } from '@/i18n';
import { fill, formatNumber } from '@/i18n/format';
import type { Locale } from '@/i18n/locale';
import { StatIcon, type StatIconName } from '@/components/statistics/owner/icons';
import '@/components/statistics/owner/owner-statistics.css';

/*
 * The owner's statistics pages (`/rees/[id]/statistics`, `/workspace/sources`,
 * `/workspace/answers`) in the prototype's markup (dot-statistics.js,
 * workspace-details.js), styled by owner-statistics.css under `.pst`. No hooks
 * and no 'use client'. The console and the dashboard keep the Tailwind pieces
 * in components/statistics/shared.tsx.
 */

/** The page wrapper: the `.pst` scope and the prototype's `.page.creator-detail-page`. */
export function OwnerPage({ official = false, children }: { official?: boolean; children: ReactNode }) {
  return (
    <main className="pst">
      <div className={`page creator-detail-page${official ? ' official-statistics' : ''}`}>{children}</div>
    </main>
  );
}

export function OwnerHeading({ title, lede, tag }: { title: string; lede: string; tag: string }) {
  return (
    <div className="creator-detail-heading">
      <div>
        <h1>{title}</h1>
        <p>{lede}</p>
      </div>
      <span className="tag blue">{tag}</span>
    </div>
  );
}

/** The strip of totals under the heading (`/workspace/*`). */
export function OwnerSummary({ locale, items }: { locale: Locale; items: [string, number][] }) {
  return (
    <div className="creator-detail-summary">
      {items.map(([label, value]) => (
        <span key={label}>
          {label}
          <strong>{formatNumber(value, locale)}</strong>
        </span>
      ))}
    </div>
  );
}

/** A table that scrolls sideways inside its card on a phone, never the page. */
export function OwnerTable({ label, heads, children, empty }: { label: string; heads: ReactNode[]; children: ReactNode[]; empty: ReactNode }) {
  return (
    <div className="table-wrap creator-detail-table" role="region" aria-label={label} tabIndex={0}>
      <table>
        <thead>
          <tr>
            {heads.map((head, index) => (
              <th key={index} scope="col">
                {head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {children.length ? (
            children
          ) : (
            <tr>
              <td colSpan={heads.length}>{empty}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function OwnerEmpty({ icon, title, body }: { icon: StatIconName; title: string; body: string }) {
  return (
    <div className="creator-detail-empty">
      <StatIcon name={icon} />
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  );
}

/** "第 a–b 项，共 N 项" and previous / next links. */
export function OwnerPager({ t, locale, page, size, total, href }: { t: Messages; locale: Locale; page: number; size: number; total: number; href: (page: number) => string }) {
  const p = t.statistics.pager;
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(1, page), pages);
  const n = (value: number) => formatNumber(value, locale);
  return (
    <div className="creator-detail-pagination" role="navigation" aria-label={p.label}>
      <span>{total ? fill(p.range, { from: n((current - 1) * size + 1), to: n(Math.min(current * size, total)), total: n(total) }) : p.empty}</span>
      <div>
        {current > 1 ? (
          <Link href={href(current - 1)} className="btn secondary sm">
            {p.previous}
          </Link>
        ) : (
          <button type="button" className="btn secondary sm" disabled>
            {p.previous}
          </button>
        )}
        <span>
          {current} / {pages}
        </span>
        {current < pages ? (
          <Link href={href(current + 1)} className="btn secondary sm">
            {p.next}
          </Link>
        ) : (
          <button type="button" className="btn secondary sm" disabled>
            {p.next}
          </button>
        )}
      </div>
    </div>
  );
}

/** The question, the answer behind a disclosure ("查看回答正文"). */
export function OwnerAnswerCell({ question, answer, t }: { question: string; answer: string; t: Messages }) {
  const d = t.statistics.detail;
  return (
    <>
      <strong className="creator-answer-question">{question || d.noQuestion}</strong>
      <details className="creator-answer-detail">
        <summary>{d.readAnswer}</summary>
        <div>{answer}</div>
      </details>
    </>
  );
}

export function OwnerCitationCell({ citation, t, locale }: { citation: CitationSnapshot | null; t: Messages; locale: Locale }) {
  if (!citation) return <>{t.statistics.detail.noSource}</>;
  return (
    <>
      {citation.title}
      <small className="creator-cell-note">{locatorLabel(citation.locator, locale)}</small>
    </>
  );
}

export function OwnerTakenDown({ t }: { t: Messages }) {
  return <span className="tag red creator-taken-down">{t.statistics.workspace.takenDown}</span>;
}
