import type { Metadata } from 'next';
import { RETRIEVAL_SETTING_GROUPS } from '@/components/admin/retrieval-config-groups';
import { RetrievalConfigForm } from '@/components/admin/retrieval-config-form';
import {
  ConsolePageHeader,
  EmptyRow,
  Panel,
  PanelHead,
  Pill,
  TableScroller,
  TD,
  TH,
} from '@/components/admin/ui';
import { readRetrievalConfiguration, retrievalProviderStatus } from '@/lib/application/administration';
import { requireAdminCapability } from '@/lib/http/admin';
import { fill } from '@/lib/i18n/format';
import { translations } from '@/lib/i18n/server';
import { updateRetrievalConfigAction } from './actions';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await translations()).t.admin.retrieval.title };
}

/**
 * Retrieval's tunables. architecture.md 9.2, 9.3, 9.6: recall widths, the
 * fusion constant, the rerank window, the public cache TTL, the playground's
 * excerpt budgets and the library-routing limits. A save is in force on the
 * next request -- the settings are read per call -- and the public result
 * cache keys on the configuration row, so it retires itself.
 *
 * Same capability as plans and the playground model: this is product
 * configuration, and it is the same people who tune it.
 */
export default async function AdminRetrievalPage() {
  await requireAdminCapability('models');
  const [{ locale, t }, { current, history }] = await Promise.all([
    translations(),
    readRetrievalConfiguration(),
  ]);
  const p = t.admin.retrieval;
  const providers = await retrievalProviderStatus();
  const number = new Intl.NumberFormat(locale);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <div className="flex flex-col gap-[22px]">
      <ConsolePageHeader eyebrow={t.admin.eyebrow} title={p.title} description={p.description} />

      <Panel>
        <PanelHead
          title={p.currentTitle}
          description={
            current.createdAt
              ? fill(p.currentSince, { date: date.format(current.createdAt) })
              : p.currentDefaults
          }
        />
        {/* The stages that only run with a provider configured, and whether one is. */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-[19px] py-3">
          {(['embeddings', 'rerank'] as const).map((stage) => (
            <span key={stage} className="flex items-center gap-2 text-[11.5px] text-muted">
              {p.providers[stage]}
              <Pill tone={providers[stage] ? 'ok' : 'warn'}>
                {providers[stage] ? p.providers.on : p.providers.off}
              </Pill>
            </span>
          ))}
          {providers.rerank ? null : (
            <span className="text-[11px] text-faint">{p.providers.rerankOff}</span>
          )}
        </div>
        <div className="grid gap-px bg-line sm:grid-cols-2 lg:grid-cols-5">
          {RETRIEVAL_SETTING_GROUPS.map((group) => (
            <div key={group.id} className="flex flex-col gap-2 bg-card px-[19px] py-4">
              <p className="text-[10.5px] font-bold tracking-[0.06em] text-faint uppercase">
                {p.groups[group.id]}
              </p>
              {group.keys.map((key) => (
                <p key={key} className="flex items-baseline justify-between gap-3">
                  <span className="text-[11.5px] tracking-[-0.023em] text-muted">
                    {p.fields[key].label}
                  </span>
                  <span className="font-mono text-[12px] font-semibold text-ink">
                    {number.format(current[key])}
                  </span>
                </p>
              ))}
            </div>
          ))}
        </div>
      </Panel>

      <Panel>
        <PanelHead title={p.configTitle} description={p.configDescription} />
        <RetrievalConfigForm current={current} action={updateRetrievalConfigAction} />
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
                      {number.format(row.recallLimit)} · k={number.format(row.rrfK)}
                    </td>
                    <td className={TD}>
                      {number.format(row.rerankWindow)} × {number.format(row.rerankDocumentChars)}
                    </td>
                    <td className={TD}>{number.format(row.cacheTtlSeconds)} s</td>
                    <td className={TD}>
                      {number.format(row.playgroundTokensDefault)} /{' '}
                      {number.format(row.playgroundTokensMax)}
                    </td>
                    <td className={TD}>
                      {number.format(row.routingRecallLimit)} ·{' '}
                      {number.format(row.routingRareSampleCap)} ·{' '}
                      {number.format(row.routingResultLimit)}
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
