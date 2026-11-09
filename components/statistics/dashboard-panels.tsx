import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { CREDIT_USD } from '@/lib/constants';
import type { KycState } from '@/lib/domain/kyc';
import type { PayoutStage } from '@/lib/domain/payouts';
import type { DashboardData, SourceSummary } from '@/lib/services/statistics';
import type { Messages } from '@/i18n';
import { fill, formatNumber } from '@/i18n/format';
import type { Locale } from '@/i18n/locale';
import { Icon } from '@/components/ui/icons';

/* The dashboard's lower panels (prototype workspace.js `attention`, `health`, `distribution`, `income`; styles in ./dashboard.css). */

const STATES = ['ready', 'processing', 'failed', 'paused'] as const;

/** Rees with a takedown, no sources, failed or processing sources; five at most, then a link to all. */
export function AttentionPanel({ t, locale, rows, total }: { t: Messages; locale: Locale; rows: DashboardData['attention']; total: number }) {
  const a = t.statistics.dashboard.attention;
  const n = (value: number) => formatNumber(value, locale);
  return (
    <section className="card creator-attention">
      <div className="creator-panel-heading">
        <h2>{a.title}</h2>
        <span className="creator-count">{n(total)}</span>
      </div>
      {rows.length ? (
        rows.map((row) => {
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
            <Link key={row.reeId} href={href} className="creator-attention-row">
              <div>
                <strong>{row.name}</strong>
                <p>{detail}</p>
              </div>
              <Icon name="arrow" className="" />
            </Link>
          );
        })
      ) : (
        <div className="creator-attention-empty">
          <Icon name="check" className="" />
          <strong>{a.emptyTitle}</strong>
          <p>{a.emptyBody}</p>
        </div>
      )}
      {total > rows.length && (
        <Link href="/rees" className="text-link creator-overview-more">
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
    <section className="card creator-health">
      <div className="creator-panel-heading">
        <div>
          <h2>{h.title}</h2>
          <p>{h.lede}</p>
        </div>
        <strong>
          {n(sources.total)} <small>{h.unit}</small>
        </strong>
      </div>
      {sources.total ? (
        <>
          <div className="creator-health-bar" role="img" aria-label={STATES.map((state) => `${h.states[state]} ${sources[state]}`).join(', ')}>
            {STATES.map((state) => (
              <span key={state} className={state} style={{ width: `${(sources[state] / sources.total) * 100}%` }} />
            ))}
          </div>
          <div className="creator-health-legend">
            {STATES.map((state) => (
              <div key={state}>
                <i className={state} />
                <span>{h.states[state]}</span>
                <strong>{n(sources[state])}</strong>
              </div>
            ))}
          </div>
        </>
      ) : (
        <p className="creator-empty-note">{h.empty}</p>
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
    <section className="card creator-distribution">
      <div className="creator-panel-heading">
        <div>
          <h2>{reeCount > 5 ? r.top : r.all}</h2>
          <p>{r.lede}</p>
        </div>
        <Icon name="chat" className="" />
      </div>
      {sum ? (
        ranking.map((row) => (
          <div key={row.reeId} className="creator-answer-row">
            <div>
              <Link href={`/rees/${row.reeId}/statistics`}>
                <span>{row.name}</span>
                {moderated.has(row.reeId) && <span className="tag text-red">{t.statistics.workspace.takenDown}</span>}
              </Link>
              <strong>{n(row.answers)}</strong>
            </div>
            <div className="creator-answer-bar">
              <span style={{ width: `${(row.answers / max) * 100}%` }} />
            </div>
          </div>
        ))
      ) : (
        <p className="creator-empty-note">{r.empty}</p>
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
      <section className="card creator-income creator-official">
        <h2 className="text-[15px] font-semibold">{p.officialTitle}</h2>
        <p>{p.officialBody}</p>
      </section>
    );
  }
  const identity = stage === 'identity_required' || stage === 'identity_pending';
  const copy = g.stages[stage === 'identity_required' && (kyc === 'rejected' || kyc === 'reset') ? 'identity_resubmit' : stage];
  const href = identity ? '/settings/identity' : stage === 'threshold' ? '/settings?tab=billing&activity=income#credit-activity' : '/settings?tab=balance#payouts';
  return (
    <section className="card creator-income">
      <div className="creator-panel-heading">
        <h2>{g.title}</h2>
        <Icon name="wallet" className="" />
      </div>
      <div className="creator-income-balance">
        <span>{g.balance}</span>
        <strong>${(earned * CREDIT_USD).toFixed(2)}</strong>
        <small>
          {n(earned)} {t.common.units.credits}
        </small>
      </div>
      {held > 0 && (
        <div className="creator-held">
          {g.held}
          <strong>
            {n(held)} {t.common.units.credits}
          </strong>
        </div>
      )}
      <div className="creator-income-state">
        <span className="creator-state-icon">
          <Icon name={identity ? 'shield' : 'wallet'} className="" />
        </span>
        <div>
          <h3>{copy.title}</h3>
          <p>{copy.body}</p>
        </div>
      </div>
      <Link href={href} className="btn-secondary">
        {copy.action}
        <Icon name="arrow" className="" />
      </Link>
      <p className="creator-income-foot">{g.foot}</p>
    </section>
  );
}
