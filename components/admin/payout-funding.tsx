import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { Fragment, type ReactNode } from 'react';
import { PAYOUT_REVIEW_SIGNALS, QUERY_FEE } from '@/lib/constants';
import type { FundingFlag, PayoutFundingSummary } from '@/lib/domain/payout-funding';
import type { FundingLine, PayoutFunding } from '@/lib/services/payout-funding';
import type { Messages } from '@/i18n';
import type { Locale } from '@/i18n/locale';
import { fill, formatDate, formatNumber } from '@/i18n/format';
import { CI } from '@/components/admin/console-icon';
import { Person, RecordsTable, Subline, Tag } from '@/components/admin/list-kit';
import { creditsUsd } from '@/components/admin/payout-kit';

const percent = (share: number) => `${Math.round(share * 1000) / 10}%`;
const DAY_MS = 86_400_000;

/** Each raised flag, worded with its numbers and threshold. */
function flagText(t: Messages, flag: FundingFlag, s: PayoutFundingSummary, locale: Locale): string {
  const f = t.consolePayouts.funding.flags;
  const signals = PAYOUT_REVIEW_SIGNALS;
  switch (flag) {
    case 'top_payer':
      return fill(f.top_payer, { share: percent(s.topShare), threshold: percent(signals.topPayerShare) });
    case 'fresh_payers':
      return fill(f.fresh_payers, { n: s.fresh.payers, days: signals.freshPayerDays, share: percent(s.fresh.share), threshold: percent(signals.freshPayerShare) });
    case 'exclusive_payers':
      return fill(f.exclusive_payers, { n: s.exclusive.payers, share: percent(s.exclusive.share), threshold: percent(signals.exclusivePayerShare) });
    case 'shared_identity':
      return fill(f.shared_identity, { n: s.sharedIdentity });
    case 'max_fee':
      return fill(f.max_fee, { n: s.maxFee.questions, share: percent(s.maxFee.share), max: formatNumber(QUERY_FEE.max, locale), threshold: percent(signals.maxFeeShare) });
    case 'refunded':
      return fill(f.refunded, { credits: formatNumber(s.drawnRefunded, locale), share: percent(s.drawn > 0 ? s.drawnRefunded / s.drawn : 0) });
  }
}

function rows(items: [ReactNode, ReactNode][]) {
  return (
    <div className="review-checklist">
      {items.map(([label, value], index) => (
        <div key={index}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  );
}

/**
 * The review page's "资金来源与付款人" (review H2): who paid for the earned
 * credits a payout draws on, from what, the signals worth a second look, and
 * the applicant's earnings by maturity. Read-only; approval is decided
 * elsewhere on the page, as before.
 */
export function PayoutFundingCards({ t, locale, data, pageHref, back, now = new Date() }: { t: Messages; locale: Locale; data: PayoutFunding; pageHref: (page: number) => string; back: string; now?: Date }) {
  const f = t.consolePayouts.funding;
  const s = data.summary;
  const n = (value: number) => formatNumber(value, locale);
  const credits = (value: number) => `${n(value)} credits · ${creditsUsd(value)}`;
  const pages = Math.max(1, Math.ceil(data.payers.total / data.payers.size));
  const page = data.payers.page;
  const sources = s.sources;
  const m = data.maturity;
  return (
    <>
      <section className="card payout-detail-card">
        <h2>{f.title}</h2>
        <p className="form-hint mb16">{f.lede}</p>
        {rows([
          [f.drawn, credits(s.drawn)],
          [f.traced, credits(s.traced)],
          [f.payers, n(s.payers)],
          [f.questions, n(s.questions)],
          [f.topShare, s.payers ? percent(s.topShare) : '—'],
          [f.top3Share, s.payers ? percent(s.top3Share) : '—'],
        ])}
        {s.traced < s.drawn && <p className="form-hint mt16">{fill(f.untraced, { credits: n(s.drawn - s.traced) })}</p>}
        <h3 className="payout-funding-subtitle">{f.flagsTitle}</h3>
        {s.flags.length ? (
          <ul className="payout-funding-flags">
            {s.flags.map((flag) => (
              <li key={flag}>
                <CI name="info" />
                <span>{flagText(t, flag, s, locale)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="form-hint">{f.noFlags}</p>
        )}
        <h3 className="payout-funding-subtitle">{f.sourcesTitle}</h3>
        {rows([
          [f.sources.paid, n(sources.paid)],
          [f.sources.refunded, n(sources.refunded)],
          [f.sources.welcome, n(sources.welcome)],
          [f.sources.redeemed, n(sources.redeemed)],
          [f.sources.console, n(sources.console)],
          [f.sources.earnedFree, n(sources.earnedFree)],
          [f.drawnRefunded, n(s.drawnRefunded)],
        ])}
        <p className="form-hint mt16">{f.sourcesNote}</p>
      </section>
      <section className="card payout-detail-card">
        <h2>{f.payersTitle}</h2>
        <RecordsTable
          label={f.payersTitle}
          empty={f.noPayers}
          head={[f.columns.payer, f.columns.credits, f.columns.questions, f.columns.age, f.columns.signals]}
          rows={data.payers.items.map((payer) => [
            <Person key="payer" name={payer.name} email={payer.email} href={`/admin/users/${payer.userId}?from=${back}`} />,
            <Fragment key="credits">
              <strong className="mono">{n(payer.credits)}</strong>
              <Subline>{fill(f.share, { share: percent(payer.share) })}</Subline>
            </Fragment>,
            <span key="questions">{n(payer.questions)}</span>,
            <span key="age">{fill(f.ageDays, { n: Math.max(0, Math.floor((now.getTime() - payer.createdAt.getTime()) / DAY_MS)) })}</span>,
            <span key="signals" className="payout-funding-tags">
              {payer.disabled && <Tag tone="red">{f.tags.disabled}</Tag>}
              {payer.fresh && <Tag tone="orange">{f.tags.fresh}</Tag>}
              {payer.exclusive && <Tag tone="orange">{f.tags.exclusive}</Tag>}
              {payer.sharesIdentity && <Tag tone="red">{f.tags.shared}</Tag>}
              {!payer.disabled && !payer.fresh && !payer.exclusive && !payer.sharesIdentity && '—'}
            </span>,
          ])}
        />
        {pages > 1 && (
          <nav className="payout-funding-pager" aria-label={f.payersTitle}>
            {page > 1 ? <Link href={pageHref(page - 1)} className="text-link">{f.previous}</Link> : <span />}
            <span>{fill(f.page, { page, pages })}</span>
            {page < pages ? <Link href={pageHref(page + 1)} className="text-link">{f.next}</Link> : <span />}
          </nav>
        )}
      </section>
      <section className="card payout-detail-card">
        <h2>{f.maturityTitle}</h2>
        {rows([
          [f.withdrawable, credits(m.withdrawable)],
          [f.maturing, credits(m.maturing)],
          ...m.schedule.map((entry) => [fill(f.maturesOn, { date: formatDate(entry.date, locale) }), n(entry.credits)] as [ReactNode, ReactNode]),
          ...(m.later > 0 ? [[f.later, n(m.later)] as [ReactNode, ReactNode]] : []),
          [f.locked, credits(m.locked)],
        ])}
      </section>
    </>
  );
}

/** The queue's line under each request: distinct payers, the top one's share, how many signals. */
export function FundingSummaryLine({ t, line }: { t: Messages; line: FundingLine | undefined }) {
  const f = t.consolePayouts.funding;
  if (!line || line.payers === 0) return <Subline>{f.lineEmpty}</Subline>;
  return (
    <Subline className={line.flags.length ? 'payout-funding-flagged' : ''}>
      {fill(f.line, { payers: line.payers, share: percent(line.topShare) })}
      {line.flags.length > 0 && ` · ${fill(f.lineFlags, { n: line.flags.length })}`}
    </Subline>
  );
}
