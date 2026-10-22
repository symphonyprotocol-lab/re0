import type { Metadata } from 'next';
import { ReviewRulesForm } from '@/components/admin/review-rules-form';
import { ConsolePageHeader, EmptyRow, Panel, PanelHead, Pill, TableScroller, TD, TH } from '@/components/admin/ui';
import { readReviewRulesConfiguration } from '@/lib/application/review';
import { REVIEW_RULE_KEYS } from '@/lib/domain/auto-review';
import { requireAdminCapability } from '@/lib/http/admin';
import { translations } from '@/lib/i18n/server';
import { updateReviewRulesAction } from '../actions';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await translations()).t.admin.reviewRules.title };
}

/**
 * The rules layer's thresholds (review-visibility-proposal.md 6.1,
 * lib/domain/auto-review.ts): what a public submission is sent back for,
 * what it may publish on without a person, and how many auto-published
 * libraries a person still looks at. Same capability as review itself.
 */
export default async function AdminReviewRulesPage() {
  await requireAdminCapability('libraries');
  const [{ locale, t }, { current, history }] = await Promise.all([translations(), readReviewRulesConfiguration()]);
  const p = t.admin.reviewRules;
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <div className="flex flex-col gap-[22px]">
      <ConsolePageHeader eyebrow={t.admin.eyebrow} title={p.title} description={p.description} />

      <Panel>
        <PanelHead
          title={p.currentTitle}
          description={current.createdAt ? `${p.since} ${date.format(current.createdAt)}` : p.defaultsInForce}
        />
        <dl className="grid gap-px bg-line sm:grid-cols-2 lg:grid-cols-3">
          {REVIEW_RULE_KEYS.map((key) => (
            <div key={key} className="flex flex-col gap-1 bg-card px-[19px] py-4">
              <dt className="text-[11.5px] tracking-[-0.023em] text-muted">{p.fields[key].label}</dt>
              <dd className="font-mono text-[14px] font-semibold text-ink">
                {key === 'autoPublish' ? (current[key] === 1 ? p.on : p.off) : current[key]}
              </dd>
            </div>
          ))}
        </dl>
        <p className="border-t-2 border-line px-[19px] py-3 text-[11px] leading-[1.55] tracking-[-0.023em] text-muted">{p.gatesNote}</p>
      </Panel>

      <Panel>
        <PanelHead title={p.configTitle} description={p.configDescription} />
        <ReviewRulesForm current={current} action={updateReviewRulesAction} />
      </Panel>

      <Panel>
        <PanelHead title={p.historyTitle} />
        <TableScroller>
          <table className="w-full">
            <thead>
              <tr className="border-b-2 border-line">
                {p.historyColumns.map((column) => (
                  <th key={column} className={TH}>
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {history.length === 0 ? (
                <EmptyRow columns={p.historyColumns.length} message={p.none} />
              ) : (
                history.map((row, at) => (
                  <tr key={row.id} className="border-b border-line last:border-b-0">
                    <td className={TD}>
                      <span className="flex items-center gap-2">
                        {date.format(row.createdAt)}
                        {at === 0 ? <Pill tone="ok">{p.inForce}</Pill> : null}
                      </span>
                    </td>
                    <td className={TD}>
                      {row.trustMin} / {row.benchmarkMin}
                    </td>
                    <td className={TD}>{row.ownerHitRateMin}%</td>
                    <td className={TD}>{row.duplicateMax}%</td>
                    <td className={TD}>{row.sampleRate}%</td>
                    <td className={TD}>{row.autoPublish === 1 ? p.on : p.off}</td>
                    <td className={TD}>
                      {row.expertMinQuestions} / {row.expertHitRateMin}%
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </TableScroller>
      </Panel>
    </div>
  );
}
