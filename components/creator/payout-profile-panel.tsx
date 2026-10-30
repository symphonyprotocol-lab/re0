import { PANEL } from '@/components/dashboard/ui';
import type { PublisherEarnings } from '@/lib/application/revenue';
import { TAX_FORM_KINDS } from '@/lib/application/revenue/payout-profile';
import type { Dictionary } from '@/lib/i18n/dictionary';
import { fill } from '@/lib/i18n/format';
import { savePayoutProfileAction } from '@/app/dashboard/revenue/actions';
import { formatUsd } from './format';

const FIELD = 'h-9 rounded-md border border-line bg-field px-3 text-[13px] text-ink';
const SMALL = 'inline-flex h-9 items-center rounded-md border border-line bg-card px-3 text-[12px] font-medium text-steel hover:bg-subtle';

/**
 * The creator's payout profile and balance (agent-first-proposal.md 6.9):
 * where cash goes, the tax-document record, and -- when a chargeback has
 * taken back income already paid out -- why nothing can leave until the
 * balance clears.
 */
export function PayoutProfilePanel({
  account,
  balanceMinor,
  canEdit,
  notice,
  t,
  locale,
}: {
  account: PublisherEarnings['account'];
  balanceMinor: number;
  canEdit: boolean;
  notice: string | null;
  t: Dictionary;
  locale: string;
}) {
  const c = t.creator.dashboard.payoutProfile;
  const errors = t.creator.errors as Record<string, string>;
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
  const good = notice !== null && notice in c.notices;
  const message = notice === null ? null : ((c.notices as Record<string, string>)[notice] ?? errors[notice] ?? errors.unavailable);
  const status = account?.taxFormStatus ?? 'missing';
  const statusLine = fill(c.status[status], {
    date: date.format(status === 'verified' ? (account?.taxFormVerifiedAt ?? new Date()) : (account?.taxFormSubmittedAt ?? new Date())),
  });

  return (
    <section id="profile" className={`${PANEL} flex flex-col gap-4 p-6`}>
      <div className="flex flex-col gap-1">
        <h2 className="text-[15px] font-medium text-ink">{c.title}</h2>
        <p className="text-[12px] leading-[1.5] text-muted">{c.description}</p>
      </div>
      <p className={`text-[13px] ${balanceMinor < 0 ? 'text-rose' : 'text-ink'}`}>{fill(c.balance, { amount: formatUsd(balanceMinor, locale) })}</p>
      {balanceMinor < 0 ? <p className="rounded-md border border-rose/30 bg-rose/5 px-4 py-3 text-[12px] leading-[1.6] text-rose">{c.negative}</p> : null}
      {message ? (
        <p role="status" className={`text-[12.5px] ${good ? 'text-brandink' : 'text-rose'}`}>
          {message}
        </p>
      ) : null}
      {canEdit ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <form action={savePayoutProfileAction} className="flex flex-col gap-2">
            <input type="hidden" name="intent" value="email" />
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-steel">{c.emailLabel}</span>
              <input name="payeeEmail" type="email" required defaultValue={account?.payeeEmail ?? ''} className={FIELD} />
            </label>
            <button type="submit" className={`${SMALL} w-fit`}>
              {c.save}
            </button>
          </form>
          <form action={savePayoutProfileAction} className="flex flex-col gap-2">
            <input type="hidden" name="intent" value="tax" />
            <p className="text-[12px] font-medium text-ink">{c.taxTitle}</p>
            <p className="text-[11px] leading-[1.5] text-muted">{c.taxBody}</p>
            <p className="text-[12px] text-steel">{statusLine}</p>
            <span className="flex flex-wrap gap-2">
              <select name="taxFormKind" defaultValue={account?.taxFormKind ?? 'W-9'} aria-label={c.kindLabel} className={FIELD}>
                {TAX_FORM_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {c.kinds[kind]}
                  </option>
                ))}
              </select>
              <button type="submit" className={SMALL}>
                {c.submit}
              </button>
            </span>
          </form>
        </div>
      ) : null}
    </section>
  );
}
