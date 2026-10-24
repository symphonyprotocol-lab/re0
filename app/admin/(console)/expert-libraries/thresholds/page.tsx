import type { Metadata } from 'next';
import { ExpertThresholdsForm } from '@/components/admin/expert-thresholds-form';
import { ConsolePageHeader, EmptyRow, Panel, PanelHead, Pill, TableScroller, TD, TH } from '@/components/admin/ui';
import { readExpertThresholdsConfiguration } from '@/lib/application/expert-libraries';
import { EXPERT_THRESHOLD_KEYS } from '@/lib/domain/expert-thresholds';
import { requireAdminCapability } from '@/lib/http/admin';
import { translations } from '@/lib/i18n/server';
import { updateExpertThresholdsAction } from '../actions';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await translations()).t.admin.expertThresholds.title };
}

/**
 * The expert gate's thresholds (review-visibility-proposal.md 5.3,
 * lib/domain/expert-thresholds.ts): how many questions a library brings
 * before it may apply, and the share of them its current version must
 * answer. Same capability as the expert queue itself.
 */
export default async function AdminExpertThresholdsPage() {
  await requireAdminCapability('expertLibraries');
  const [{ locale, t }, { current, history }] = await Promise.all([translations(), readExpertThresholdsConfiguration()]);
  const p = t.admin.expertThresholds;
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <div className="flex flex-col gap-[22px]">
      <ConsolePageHeader eyebrow={t.admin.eyebrow} title={p.title} description={p.description} />

      <Panel>
        <PanelHead
          title={p.currentTitle}
          description={current.createdAt ? `${p.since} ${date.format(current.createdAt)}` : p.defaultsInForce}
        />
        <dl className="grid gap-px bg-line sm:grid-cols-2">
          {EXPERT_THRESHOLD_KEYS.map((key) => (
            <div key={key} className="flex flex-col gap-1 bg-card px-[19px] py-4">
              <dt className="text-[11.5px] tracking-[-0.023em] text-muted">{p.fields[key].label}</dt>
              <dd className="font-mono text-[14px] font-semibold text-ink">{current[key]}</dd>
            </div>
          ))}
        </dl>
        <p className="border-t-2 border-line px-[19px] py-3 text-[11px] leading-[1.55] tracking-[-0.023em] text-muted">{p.gateNote}</p>
      </Panel>

      <Panel>
        <PanelHead title={p.configTitle} description={p.configDescription} />
        <ExpertThresholdsForm current={current} action={updateExpertThresholdsAction} />
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
                    <td className={TD}>{row.expertMinQuestions}</td>
                    <td className={TD}>{row.expertHitRateMin}%</td>
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
