'use client';

import { useNavigationRouter as useRouter } from '@/components/shell/navigation-provider';
import { useState } from 'react';
import { ADMIN_REASON, PAYOUT_TRANSFER_ID_MAX } from '@/lib/constants';
import { creditsToCents, formatCentsUsd as usd, liveFeeCents } from '@/lib/domain/payouts';
import { api } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { fill } from '@/i18n/format';
import { CI } from '@/components/admin/console-icon';
import { useConfirmStep } from '@/components/admin/confirm-step';
import { useToast } from '@/components/ui/toast';

/** Who a payout goes to, named in the confirmation of every final decision on it. */
export interface Payee {
  name: string;
  paypal: string;
}

function useAction() {
  const { t } = useI18n();
  const errors = t.consolePayouts.errors as Record<string, string>;
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  async function run(name: string, endpoint: string, body: Record<string, unknown>, done: string, next?: string) {
    setBusy(name);
    setError('');
    const result = await api<{ error?: string }>(endpoint, { method: 'POST', json: body });
    setBusy(null);
    if (!result.ok) {
      const code = result.data.error ?? '';
      setError(errors[code] ?? (t.console.errors as Record<string, string>)[code] ?? t.console.errors.generic);
      return;
    }
    toast(done);
    if (next) router.push(next);
    else router.refresh();
  }
  return { busy, error, setError, run, errors };
}

const reasonLength = (value: string) => Array.from(value.trim()).length;

/** 审核决定 (prototype `#payout-review-form`): approve keeps the hold; reject needs 3–300 characters and releases it. */
export function PayoutReview({ id, credits, payee, allowed, paymentHref }: { id: string; credits: number; payee: Payee; allowed: boolean; paymentHref: string }) {
  const { t } = useI18n();
  const d = t.consolePayouts.payoutDetail;
  const c = t.consoleConfirm.payout;
  const { busy, error, setError, run, errors } = useAction();
  const { ask, dialog } = useConfirmStep();
  const amount = usd(creditsToCents(credits));
  const [note, setNote] = useState('');
  const alert = error && (
    <p className="form-error" role="alert">
      {error}
    </p>
  );
  return (
    <form id="payout-review-form" onSubmit={(event) => event.preventDefault()}>
      <div className="field">
        <label htmlFor="review-note">{d.note}</label>
        <textarea id="review-note" name="note" rows={4} maxLength={ADMIN_REASON.max} placeholder={d.notePlaceholder} value={note} onChange={(event) => setNote(event.target.value)} />
      </div>
      {!allowed && <p className="form-error">{d.notAllowed}</p>}
      <div className="payout-page-actions">
        <button
          type="button"
          className="btn secondary"
          disabled={busy !== null}
          onClick={() => {
            if (reasonLength(note) < ADMIN_REASON.min || reasonLength(note) > ADMIN_REASON.max) return setError(errors.reason!);
            setError('');
            ask({
              title: c.rejectTitle,
              body: fill(c.rejectBody, { name: payee.name, paypal: payee.paypal, amount }),
              label: c.reject,
              danger: true,
              run: () => run('rejected', `/api/admin/payouts/${id}/reject`, { note: note.trim() }, d.rejected),
            });
          }}
        >
          {d.reject}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy !== null || !allowed}
          onClick={() => {
            if (note.trim() && (reasonLength(note) < ADMIN_REASON.min || reasonLength(note) > ADMIN_REASON.max)) return setError(errors.reason!);
            void run('approved', `/api/admin/payouts/${id}/approve`, { note: note.trim() }, d.approved, paymentHref);
          }}
        >
          {d.approve}
        </button>
      </div>
      {alert}
      {dialog}
    </form>
  );
}

/**
 * 登记打款结果 (prototype `#manual-payout-result`): the transfer id and the
 * net dollars, with the fee (requested − paid) shown as it is typed; or a
 * failure reason, which releases the hold. Both are final.
 */
export function PayoutPayment({ id, credits, payee, allowed }: { id: string; credits: number; payee: Payee; allowed: boolean }) {
  const { t } = useI18n();
  const d = t.consolePayouts.payoutDetail;
  const c = t.consoleConfirm.payout;
  const { busy, error, setError, run, errors } = useAction();
  const { ask, dialog } = useConfirmStep();
  const amount = usd(creditsToCents(credits));
  const [transferId, setTransferId] = useState('');
  const [paid, setPaid] = useState('');
  const [reason, setReason] = useState('');
  const fee = paid ? liveFeeCents(paid, credits) : null;
  const max = creditsToCents(credits);
  return (
    <form id="manual-payout-result" onSubmit={(event) => event.preventDefault()}>
      <div className="field">
        <label htmlFor="payout-transfer">{d.transferId}</label>
        <input id="payout-transfer" name="transferId" maxLength={PAYOUT_TRANSFER_ID_MAX} autoComplete="off" value={transferId} onChange={(event) => setTransferId(event.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="payout-actual">{d.paid}</label>
        <input
          id="payout-actual"
          name="actual"
          type="number"
          inputMode="decimal"
          min={0.01}
          max={Math.floor(max) / 100}
          step={0.01}
          placeholder={(Math.floor(max) / 100).toFixed(2)}
          value={paid}
          onChange={(event) => setPaid(event.target.value)}
        />
        <small>{fill(d.paidHint, { max: usd(max) })}</small>
      </div>
      <div className="payout-fee-estimate">
        <span>{d.fee}</span>
        <strong id="payout-calculated-fee" aria-live="polite">
          {fee === null ? '—' : usd(fee)}
        </strong>
      </div>
      <div className="rule" />
      <div className="field">
        <label htmlFor="payout-failure">{d.failure}</label>
        <textarea id="payout-failure" name="reason" rows={3} maxLength={ADMIN_REASON.max} placeholder={d.failurePlaceholder} value={reason} onChange={(event) => setReason(event.target.value)} />
      </div>
      {!allowed && <p className="form-error">{d.paymentPaused}</p>}
      <div className="payout-page-actions">
        <button
          type="button"
          className="btn secondary"
          disabled={busy !== null}
          onClick={() => {
            if (reasonLength(reason) < ADMIN_REASON.min || reasonLength(reason) > ADMIN_REASON.max) return setError(errors.reason!);
            setError('');
            ask({
              title: c.failedTitle,
              body: fill(c.failedBody, { name: payee.name, paypal: payee.paypal, amount }),
              label: c.failed,
              danger: true,
              run: () => run('failed', `/api/admin/payouts/${id}/failed`, { reason: reason.trim() }, d.failedDone),
            });
          }}
        >
          {d.markFailed}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy !== null || !allowed}
          onClick={() => {
            if (!transferId.trim()) return setError(errors.transfer_id!);
            if (fee === null) return setError(errors.paid_amount!);
            setError('');
            ask({
              title: c.paidTitle,
              body: fill(c.paidBody, { name: payee.name, paypal: payee.paypal, paid: usd(Math.round(Number(paid) * 100)), transfer: transferId.trim(), amount }),
              label: c.paid,
              run: () => run('paid', `/api/admin/payouts/${id}/paid`, { transferId: transferId.trim(), paid }, d.paidDone),
            });
          }}
        >
          {d.markPaid}
          <CI name="check" />
        </button>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {dialog}
    </form>
  );
}
