import { DEFAULT_BUILD_RATES } from '@/lib/domain/build-billing';
import type { Metadata } from 'next';
import {
  PlanVersionControl,
  type PlanVersionTarget,
} from '@/components/admin/plan-version-dialog';
import {
  ConsolePageHeader,
  EmptyRow,
  Panel,
  PanelHead,
  Pill,
  TableScroller,
  TD,
  TH,
  TitleCell,
} from '@/components/admin/ui';
import { CheckIcon } from '@/components/ui/icons';
import { listPlanConfiguration, type PlanVersionRow } from '@/lib/application/plans';
import {
  shortPlanVersionId,
  storageCapacityBytes,
  tierHasEntitlements,
  tierIsFree,
  usdFromMinor,
  usdHeadline,
  type PlanTierId,
} from '@/lib/domain/plans';
import { formatCapacity } from '@/lib/domain/pricing-page';
import { requireAdminCapability } from '@/lib/http/admin';
import type { Dictionary } from '@/lib/i18n/dictionary';
import { fill } from '@/lib/i18n/format';
import { translations } from '@/lib/i18n/server';
import type { Locale } from '@/lib/i18n/locale';
import { createPlanVersionAction } from './actions';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await translations()).t.admin.plans.title };
}

/**
 * Plan configuration -- design source frames `WHlyq` and `新建套餐版本`.
 *
 * Two tiers and no more: Free and the Additional Calls pack, both priced in
 * USD (agent-first-proposal.md 8.1, requirement.md 5.3). There is deliberately
 * no Pro or Enterprise card to add, and no control that edits a version in
 * place -- every row in `plan_version` is immutable, so the card's control
 * mints a successor and the history panel below shows what each superseded
 * row is still billing. Storage is not on a version: the two capacities are
 * product constants (`lib/domain/plans.ts`), shown here so the operator sees
 * the whole offer in one place.
 */
export default async function AdminPlansPage() {
  await requireAdminCapability('plans');
  const [{ locale, t }, { tiers, history }] = await Promise.all([
    translations(),
    listPlanConfiguration(),
  ]);
  const p = t.admin.plans;

  /*
   * A version's "v3" is its position in its own tier's history, oldest first.
   * The number is not stored -- there is nothing to store it on that would stay
   * true -- so it is derived here from the order the history already has.
   */
  const ordinals = new Map<string, number>();
  for (const tier of tiers) {
    const versions = history.filter((row) => row.planId === tier.id);
    versions.forEach((row, index) => ordinals.set(row.id, versions.length - index));
  }
  const versionName = (row: PlanVersionRow): string =>
    fill(p.versionName, { name: p.names[row.planId], index: ordinals.get(row.id) ?? 1 });

  const number = numberFormatter(locale);
  const intl = new Intl.NumberFormat(locale === 'zh' ? 'zh-CN' : 'en-US');
  const storage = {
    base: formatCapacity(storageCapacityBytes('base'), intl),
    extended: formatCapacity(storageCapacityBytes('extended'), intl),
  };
  const price = (row: PlanVersionRow): string =>
    row.priceMinor === 0
      ? p.free
      : `${usdHeadline(row.priceMinor)} ${row.planId === 'addon' ? p.perPack : p.perMonth}`;
  const calls = (row: PlanVersionRow): string =>
    row.planId === 'addon' ? `+${number(row.monthlyCalls)}` : number(row.monthlyCalls);

  return (
    <div className="flex flex-col gap-[18px]">
      <ConsolePageHeader eyebrow={t.admin.eyebrow} title={p.title} description={p.description} />

      <section className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {tiers.map((tier) => {
          const live = tier.live;
          const dark = tier.id === 'addon';
          return (
            <article
              key={tier.id}
              className={`flex flex-col gap-[17px] rounded-[10px] border-2 p-[19px] ${
                dark ? 'border-consoledeep bg-consoledeep' : 'border-line bg-card'
              }`}
            >
              <header className="flex items-start justify-between gap-3">
                <span className="flex flex-col gap-1">
                  <span
                    className={`text-[14px] leading-[1.3] font-semibold tracking-[-0.025em] ${
                      dark ? 'text-white' : 'text-ink'
                    }`}
                  >
                    {p.names[tier.id]}
                  </span>
                  <span
                    className={`text-[11px] tracking-[-0.023em] ${
                      dark ? 'text-consoletext' : 'text-muted'
                    }`}
                  >
                    {p.taglines[tier.id]}
                  </span>
                </span>
                <span className="flex items-baseline gap-1">
                  <span
                    className={`text-[19px] leading-[1.3] font-semibold tracking-[-0.03em] ${
                      dark ? 'text-white' : 'text-ink'
                    }`}
                  >
                    {live ? usdHeadline(live.priceMinor) : '—'}
                  </span>
                  <span
                    className={`text-[11px] tracking-[-0.023em] ${
                      dark ? 'text-consoletext' : 'text-muted'
                    }`}
                  >
                    {tier.id === 'addon' ? p.perPack : p.perMonth}
                  </span>
                </span>
              </header>

              <ul className="flex flex-1 flex-col gap-2.5">
                {(live ? perksFor(live, p, number, storage) : []).map((perk) => (
                  <li
                    key={perk}
                    className={`flex items-center gap-2 text-[12px] tracking-[-0.023em] ${
                      dark ? 'text-consoletext' : 'text-steel'
                    }`}
                  >
                    <CheckIcon size={14} className={dark ? 'text-mint' : 'text-brand'} />
                    {perk}
                  </li>
                ))}
              </ul>

              <PlanVersionControl
                action={createPlanVersionAction}
                target={targetFor(tier.id, live, {
                  name: p.names[tier.id],
                  label: live ? versionName(live) : '',
                  summary: live ? summaryFor(live, p, number, calls, price) : '',
                })}
              />
            </article>
          );
        })}
      </section>

      <Panel>
        <PanelHead
          title={p.quotaTitle}
          description={p.quotaSubtitle}
          action={<Pill tone="ok">{p.liveBadge}</Pill>}
        />

        <TableScroller>
          <table className="w-full min-w-[560px] border-collapse text-left">
            <thead>
              <tr>
                {p.quotaColumns.map((column) => (
                  <th key={column} scope="col" className={TH}>
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {quotaRows(
                tiers.map((tier) => tier.live),
                p,
                number,
                calls,
                price,
              ).map((row) => (
                <tr key={row.label} className="border-t-2 border-line">
                  <th scope="row" className={`${TD} font-semibold text-ink`}>
                    {row.label}
                  </th>
                  {row.cells.map((cell, index) => (
                    <td key={tiers[index]?.id ?? index} className={TD}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroller>

        <p className="border-t-2 border-line px-[15px] py-3 text-[11px] leading-[1.6] tracking-[-0.023em] text-muted">
          {fill(p.immutableNote, storage)}
        </p>
      </Panel>

      <Panel>
        <PanelHead
          title={p.historyTitle}
          description={p.historySubtitle}
          action={<Pill>{p.usdOnly}</Pill>}
        />

        <TableScroller>
          <table className="w-full min-w-[820px] border-collapse text-left">
            <thead>
              <tr>
                {p.historyColumns.map((column) => (
                  <th key={column} scope="col" className={TH}>
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {history.length === 0 ? (
                <EmptyRow
                  columns={p.historyColumns.length}
                  message={p.historyEmpty}
                  note={p.historyEmptyNote}
                />
              ) : (
                history.map((row) => (
                  <tr key={row.id} className="border-t-2 border-line">
                    <td className={TD}>
                      <TitleCell title={versionName(row)} meta={shortPlanVersionId(row.id)} />
                    </td>
                    <td className={TD}>{price(row)}</td>
                    <td className={TD}>{calls(row)}</td>
                    <td className={TD}>
                      {tierHasEntitlements(row.planId)
                        ? fill(p.limitsSummary, { keys: number(row.apiKeyLimit) })
                        : p.inherit}
                    </td>
                    <td className={`${TD} whitespace-nowrap`}>{timestamp(row.createdAt)}</td>
                    <td className={TD}>{row.subscriptions > 0 ? number(row.subscriptions) : p.none}</td>
                    <td className={TD}>
                      {row.isLive ? (
                        <Pill tone="ok">{p.statusLive}</Pill>
                      ) : (
                        <Pill>{p.statusSuperseded}</Pill>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </TableScroller>

        <p className="border-t-2 border-line px-[15px] py-3 text-[11px] leading-[1.6] tracking-[-0.023em] text-muted">
          {p.catalogueNote}
        </p>
      </Panel>
    </div>
  );
}

type PlanCopy = Dictionary['admin']['plans'];
type NumberFormat = (value: number) => string;

/** Grouped digits in the reader's locale; the console prints a lot of them. */
function numberFormatter(locale: Locale): NumberFormat {
  const format = new Intl.NumberFormat(locale === 'zh' ? 'zh-CN' : 'en-US');
  return (value) => format.format(value);
}

/** `YYYY-MM-DD HH:mm` in UTC, the same shape the audit log prints. */
function timestamp(value: Date): string {
  return `${value.toISOString().slice(0, 10)} ${value.toISOString().slice(11, 16)}`;
}

/**
 * The card's bullets, read off the live version rather than written by hand.
 *
 * A card that lists what a fixture says is a card that will eventually
 * disagree with what a subscriber is actually sold.
 */
function perksFor(
  live: PlanVersionRow,
  p: PlanCopy,
  number: NumberFormat,
  storage: { base: string; extended: string },
): string[] {
  if (!tierHasEntitlements(live.planId)) {
    return [
      fill(p.perkPackCalls, { calls: number(live.monthlyCalls) }),
      p.perkInherit,
    ];
  }
  return [
    fill(p.perkCalls, { calls: number(live.monthlyCalls) }),
    fill(p.perkKeys, { count: number(live.apiKeyLimit) }),
    fill(p.perkStorage, storage),
  ];
}

/** One line describing the live version, for the dialog's "this is what you are superseding". */
function summaryFor(
  live: PlanVersionRow,
  p: PlanCopy,
  number: NumberFormat,
  calls: (row: PlanVersionRow) => string,
  price: (row: PlanVersionRow) => string,
): string {
  const parts = [price(live), `${calls(live)} Calls`];
  if (tierHasEntitlements(live.planId)) {
    parts.push(fill(p.limitsSummary, { keys: number(live.apiKeyLimit) }));
  } else {
    parts.push(p.inherit);
  }
  return parts.join(' · ');
}

/**
 * What the dialog opens on.
 *
 * The defaults are today's live values, so the form is a diff rather than a
 * blank slate: an operator raising one ceiling should not have to retype the
 * others they are keeping, and a retyped value is a value that can be mistyped.
 */
function targetFor(
  planId: PlanTierId,
  live: PlanVersionRow | null,
  copy: { name: string; label: string; summary: string },
): PlanVersionTarget {
  return {
    planId,
    name: copy.name,
    live: live
      ? {
          id: live.id,
          label: copy.label,
          summary: copy.summary,
          subscriptions: live.subscriptions,
        }
      : null,
    /*
     * With no live version there is nothing to diff against, so every field is
     * blank and `required` makes the operator state it. Only Free is prefilled,
     * and only because its price is fixed by rule and the control is read-only.
     *
     * The money field must not invent a default: a "0.00" sitting in a price box
     * while every neighbour is empty reads as a value someone chose, and minting
     * a paid tier at $0 is not undoable -- versions are superseded, never fixed.
     */
    defaults: {
      price: live ? usdFromMinor(live.priceMinor) : tierIsFree(planId) ? '0.00' : '',
      calls: String(live?.monthlyCalls ?? ''),
      apiKeyLimit: String(live?.apiKeyLimit ?? ''),
      buildBaseCalls: String(live?.buildBaseCalls ?? DEFAULT_BUILD_RATES.baseCalls),
      buildTokensPerCall: String(live?.buildTokensPerCall ?? DEFAULT_BUILD_RATES.tokensPerCall),
      buildPagesPerCall: String(live?.buildPagesPerCall ?? DEFAULT_BUILD_RATES.pagesPerCall),
    },
  };
}

/** The comparison table, one row per setting and one column per tier. */
function quotaRows(
  lives: (PlanVersionRow | null)[],
  p: PlanCopy,
  number: NumberFormat,
  calls: (row: PlanVersionRow) => string,
  price: (row: PlanVersionRow) => string,
): { label: string; cells: string[] }[] {
  const cell = (
    read: (live: PlanVersionRow) => string,
    /* The pack has no ceiling of its own: its buyer keeps Free's. */
    packReads = false,
  ): string[] =>
    lives.map((live) => {
      if (!live) return p.none;
      if (!tierHasEntitlements(live.planId) && !packReads) return p.inherit;
      return read(live);
    });

  return [
    { label: p.quotaLabels.price, cells: cell(price, true) },
    { label: p.quotaLabels.calls, cells: cell(calls, true) },
    { label: p.quotaLabels.keys, cells: cell((live) => number(live.apiKeyLimit)) },
    {
      label: p.quotaLabels.build,
      cells: cell((live) =>
        fill(p.buildRateSummary, {
          base: number(live.buildBaseCalls),
          tokens: number(live.buildTokensPerCall),
          pages: number(live.buildPagesPerCall),
        }),
      ),
    },
  ];
}
