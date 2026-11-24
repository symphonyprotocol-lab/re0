import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import type { CompetitionCard } from '@/lib/services/competitions';
import type { Messages } from '@/i18n';
import { fill, formatDateTime, formatNumber } from '@/i18n/format';

/** One competition in a list: its name, state, deadline or results date, and how full it is. */
export function CompetitionCards({ items, t, locale, hrefOf }: { items: CompetitionCard[]; t: Messages; locale: 'zh' | 'en'; hrefOf?: (item: CompetitionCard) => string }) {
  const c = t.competitions;
  return (
    <ul className="flex flex-col gap-3">
      {items.map((item) => (
        <li key={item.id}>
          <Link href={hrefOf ? hrefOf(item) : `/competitions/${item.slug}`} className="card block p-4 transition hover:border-[#c4cce0]">
            <div className="flex flex-wrap items-center gap-2">
              <strong className="text-[14px]">{item.title}</strong>
              <span className="tag">{c.status[item.status]}</span>
              <span className="tag">#{item.slug}</span>
            </div>
            <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted">
              <span>{item.status === 'published' && item.publishedAt ? fill(c.card.publishedAt, { at: formatDateTime(item.publishedAt, locale) }) : item.deadlineAt ? fill(c.card.deadline, { at: formatDateTime(item.deadlineAt, locale) }) : c.card.deadlineTbd}</span>
              <span>{fill(c.card.entries, { n: formatNumber(item.entries, locale), max: formatNumber(item.maxEntries, locale) })}</span>
              <span>{fill(c.card.questions, { n: formatNumber(item.questions, locale) })}</span>
              <span>{fill(c.host, { name: item.hostName ?? c.hostSomeone })}</span>
            </p>
          </Link>
        </li>
      ))}
    </ul>
  );
}
