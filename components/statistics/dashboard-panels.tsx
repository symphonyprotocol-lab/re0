import Link from 'next/link';
import type { ReactNode } from 'react';
import { CREDIT_USD } from '@/lib/constants';
import type { KycState } from '@/lib/domain/kyc';
import type { PayoutStage } from '@/lib/domain/payouts';
import type { DashboardData, SourceSummary } from '@/lib/services/statistics';
import type { Messages } from '@/i18n';
import { fill, formatNumber } from '@/i18n/format';
import type { Locale } from '@/i18n/locale';
import { Icon } from '@/components/ui/icons';

/* The dashboard's lower panels (prototype workspace.js `attention`, `health`, `distribution`, `income`). */

const STATES = ['ready', 'processing', 'failed', 'paused'] as const;
const STATE_COLORS: Record<(typeof STATES)[number], string> = {
  ready: 'bg-green',
  processing: 'bg-blue',
  failed: 'bg-red',
  paused: 'bg-[#b6bccb]',
};

function PanelHeading({ title, lede, aside }: { title: string; lede?: string; aside?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-[15px] font-bold">{title}</h2>
        {lede && <p className="mt-1 text-[11px] text-muted">{lede}</p>}
      </div>
      {aside}
    </div>
  );
}

/** Rees with a takedown, no sources, failed or processing sources; five at most, then a link to all. */
export function AttentionPanel({ t, locale, rows, total }: { t: Messages; locale: Locale; rows: DashboardData['attention']; total: number }) {
  const a = t.statistics.dashboard.attention;
  const n = (value: number) => formatNumber(value, locale);
  return (
    <section className="card min-w-0 p-5">
      <PanelHeading title={a.title} aside={<span className="tag font-mono">{n(total)}</span>} />
      {rows.length ? (
        <ul className="mt-3 flex flex-col gap-2">
          {rows.map((row) => {
            const href = row.moderated
              ? `/rees/${row.reeId}/settings`
              : `/rees/${row.reeId}/knowledge${row.sources.failed ? '?status=failed' : row.sources.processing ? '?status=processing' : ''}`;
            const detail = row.moderated
              ? a.moderated
              : !row.sources.total
                ? a.noSources
                : [row.sources.failed ? fill(a.failed, { n: n(row.sources.failed) }) : '', row.sources.processing ? fill(a.processing, { n: n(row.sources.processing) }) : '']
                    .filter(Boolean)
                    .join(' · ');
            return (
              <li key={row.reeId}>
                <Link href={href} className="flex items-center gap-3 rounded-lg border border-line px-3 py-2.5 hover:border-[#c4cce0] hover:bg-wash">
                  <span className="min-w-0 flex-1">
                    <strong className="block truncate text-[13px]">{row.name}</strong>
                    <span className={`mt-0.5 block text-[11px] ${row.moderated || row.sources.failed ? 'text-red' : 'text-muted'}`}>{detail}</span>
                  </span>
                  <Icon name="arrow" className="size-3.5 flex-none text-muted" />
                </Link>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="mt-4 flex flex-col items-center gap-2 rounded-lg border border-dashed border-line bg-wash px-4 py-8 text-center">
          <Icon name="check" className="size-5 text-green" />
          <strong className="text-[12px]">{a.emptyTitle}</strong>
          <p className="text-[11px] text-muted">{a.emptyBody}</p>
        </div>
      )}
      {total > rows.length && (
        <Link href="/rees" className="mt-3 block text-center text-[12px] font-semibold text-blue hover:underline">
          {fill(a.more, { n: n(total - rows.length) })}
        </Link>
      )}
    </section>
  );
}

/** One stacked bar of the current source states, and its legend. */
export function HealthPanel({ t, locale, sources }: { t: Messages; locale: Locale; sources: SourceSummary }) {
  const h = t.statistics.dashboard.health;
  const n = (value: number) => formatNumber(value, locale);
  return (
    <section className="card min-w-0 p-5">
      <PanelHeading
        title={h.title}
        lede={h.lede}
        aside={
          <strong className="flex-none font-mono text-[18px]">
            {n(sources.total)} <small className="text-[11px] font-normal text-muted">{h.unit}</small>
          </strong>
        }
      />
      {sources.total ? (
        <>
          <div
            role="img"
            aria-label={STATES.map((state) => `${h.states[state]} ${sources[state]}`).join(', ')}
            className="mt-4 flex h-2.5 overflow-hidden rounded-full bg-[#edf0f6]"
          >
            {STATES.map((state) => (
              <span key={state} className={`block h-full ${STATE_COLORS[state]}`} style={{ width: `${(sources[state] / sources.total) * 100}%` }} />
            ))}
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-2">
            {STATES.map((state) => (
              <div key={state} className="flex items-center gap-2 rounded-lg bg-wash px-2.5 py-2 text-[12px]">
                <i className={`size-2 flex-none rounded-full ${STATE_COLORS[state]}`} />
                <dt className="min-w-0 flex-1 truncate text-muted">{h.states[state]}</dt>
                <dd className="font-mono font-semibold">{n(sources[state])}</dd>
              </div>
            ))}
          </dl>
        </>
      ) : (
        <p className="mt-4 rounded-lg border border-dashed border-line bg-wash px-4 py-6 text-center text-[12px] text-muted">{h.empty}</p>
      )}
    </section>
  );
}

/** Successful answers of the top five Rees as bars. */
export function RankingPanel({
  t,
  locale,
  ranking,
  reeCount,
  moderated,
}: {
  t: Messages;
  locale: Locale;
  ranking: DashboardData['ranking'];
  reeCount: number;
  moderated: Set<string>;
}) {
  const r = t.statistics.dashboard.ranking;
  const n = (value: number) => formatNumber(value, locale);
  const max = Math.max(1, ...ranking.map((row) => row.answers));
  const sum = ranking.reduce((total, row) => total + row.answers, 0);
  return (
    <section className="card min-w-0 p-5">
      <PanelHeading title={reeCount > 5 ? r.top : r.all} lede={r.lede} aside={<Icon name="chat" className="size-4 flex-none text-[#a3a9bb]" />} />
      {sum ? (
        <ul className="mt-4 flex flex-col gap-3">
          {ranking.map((row) => (
            <li key={row.reeId}>
              <div className="flex items-center justify-between gap-3 text-[12px]">
                <Link href={`/rees/${row.reeId}/statistics`} className="flex min-w-0 items-center gap-1.5 hover:text-blue">
                  <span className="truncate">{row.name}</span>
                  {moderated.has(row.reeId) && <span className="tag flex-none border-[#f1d4d4] bg-[#fff3f3] text-red">{t.statistics.workspace.takenDown}</span>}
                </Link>
                <strong className="flex-none font-mono">{n(row.answers)}</strong>
              </div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[#edf0f6]">
                <span className="block h-full rounded-full bg-blue" style={{ width: `${(row.answers / max) * 100}%` }} />
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 rounded-lg border border-dashed border-line bg-wash px-4 py-6 text-center text-[12px] text-muted">{r.empty}</p>
      )}
    </section>
  );
}

/**
 * The earned balance and where payouts stand (prototype workspace.js
 * `income`, step 6): one state from identity, the PayPal address and its
 * hold, the threshold and a payout in progress, with the way forward --
 * `/settings/identity` while identity is the gate, billing otherwise. An
 * official account gets its notice instead.
 */
export function IncomePanel({
  t,
  locale,
  earned,
  official,
  stage,
  kyc,
  held,
}: {
  t: Messages;
  locale: Locale;
  earned: number;
  official: boolean;
  stage: PayoutStage;
  kyc: KycState;
  held: number;
}) {
  const p = t.statistics.dashboard.income;
  const g = t.payouts.guide;
  const n = (value: number) => formatNumber(value, locale);
  if (official || stage === 'official') {
    return (
      <section className="card min-w-0 bg-[#fbfaff] p-5">
        <h2 className="flex items-center gap-2 text-[15px] font-bold">
          <Icon name="globe" className="size-4 text-[#7255bd]" />
          {p.officialTitle}
        </h2>
        <p className="mt-2 text-[12px] leading-relaxed text-muted">{p.officialBody}</p>
      </section>
    );
  }
  const identity = stage === 'identity_required' || stage === 'identity_pending';
  const copy = g.stages[stage === 'identity_required' && (kyc === 'rejected' || kyc === 'reset') ? 'identity_resubmit' : stage];
  const href = identity ? '/settings/identity' : stage === 'threshold' ? '/settings?tab=billing&activity=income' : '/settings?tab=billing#payouts';
  return (
    <section className="card flex min-w-0 flex-col p-5">
      <PanelHeading title={g.title} aside={<Icon name="sparkle" className="size-4 flex-none text-[#a3a9bb]" />} />
      <div className="mt-4 rounded-xl bg-ink px-4 py-3.5 text-white">
        <span className="text-[11px] text-white/70">{g.balance}</span>
        <strong className="mt-1 block font-mono text-[24px] leading-none">${(earned * CREDIT_USD).toFixed(2)}</strong>
        <small className="mt-1 block font-mono text-[11px] text-white/70">{n(earned)} credits</small>
      </div>
      {held > 0 && (
        <p className="mt-3 flex items-center justify-between gap-2 rounded-lg bg-[#fff7ec] px-3 py-2 text-[12px] text-orange">
          {g.held}
          <strong className="font-mono">{n(held)} credits</strong>
        </p>
      )}
      <div className="mt-4 flex items-start gap-3">
        <span className="inline-flex size-8 flex-none items-center justify-center rounded-lg bg-soft text-blue">
          <Icon name={identity ? 'shield' : 'sparkle'} className="size-4" />
        </span>
        <div className="min-w-0">
          <h3 className="text-[13px] font-bold">{copy.title}</h3>
          <p className="mt-1 text-[12px] leading-relaxed text-muted">{copy.body}</p>
        </div>
      </div>
      <Link href={href} className="btn-secondary mt-4 w-full">
        {copy.action}
        <Icon name="arrow" />
      </Link>
      <p className="mt-3 text-[11px] text-muted">{g.foot}</p>
    </section>
  );
}
