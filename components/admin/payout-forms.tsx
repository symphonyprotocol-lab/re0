'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ADMIN_REASON, PAYOUT_TRANSFER_ID_MAX } from '@/lib/constants';
import { creditsToCents, formatCentsUsd as usd, liveFeeCents } from '@/lib/domain/payouts';
import { api } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { fill } from '@/i18n/format';
import { Icon, Spinner } from '@/components/ui/icons';
import { useToast } from '@/components/ui/toast';


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
export function PayoutReview({ id, allowed, paymentHref }: { id: string; allowed: boolean; paymentHref: string }) {
  const { t } = useI18n();
  const d = t.consolePayouts.payoutDetail;
  const { busy, error, setError, run, errors } = useAction();
  const [note, setNote] = useState('');
  return (
    <form onSubmit={(event) => event.preventDefault()}>
      <label htmlFor="review-note" className="field-label">
        {d.note}
      </label>
      <textarea id="review-note" rows={4} maxLength={ADMIN_REASON.max} placeholder={d.notePlaceholder} value={note} onChange={(event) => setNote(event.target.value)} className="input resize-y" />
      <small className="hint block">{reasonLength(note)} / {ADMIN_REASON.max}</small>
      {!allowed && <p className="mt-3 rounded-lg bg-[#fff3f3] px-3 py-2 text-[12px] text-red">{d.notAllowed}</p>}
      {error && (
        <p role="alert" className="mt-3 text-[12px] text-red">
          {error}
        </p>
      )}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          className="btn-secondary"
          disabled={busy !== null}
          onClick={() => {
            if (reasonLength(note) < ADMIN_REASON.min || reasonLength(note) > ADMIN_REASON.max) return setError(errors.reason!);
            void run('rejected', `/api/admin/payouts/${id}/reject`, { note: note.trim() }, d.rejected);
          }}
        >
          {busy === 'rejected' && <Spinner />}
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
          {busy === 'approved' ? <Spinner /> : <Icon name="check" className="size-4" />}
          {d.approve}
        </button>
      </div>
    </form>
  );
}

/**
 * 登记打款结果 (prototype `#manual-payout-result`): the transfer id and the
 * net dollars, with the fee (requested − paid) shown as it is typed; or a
 * failure reason, which releases the hold. Both are final.
 */
export function PayoutPayment({ id, credits, allowed }: { id: string; credits: number; allowed: boolean }) {
  const { t } = useI18n();
  const d = t.consolePayouts.payoutDetail;
  const { busy, error, setError, run, errors } = useAction();
  const [transferId, setTransferId] = useState('');
  const [paid, setPaid] = useState('');
  const [reason, setReason] = useState('');
  const fee = paid ? liveFeeCents(paid, credits) : null;
  const max = creditsToCents(credits);
  return (
    <form onSubmit={(event) => event.preventDefault()}>
      <label htmlFor="payout-transfer" className="field-label">
        {d.transferId}
      </label>
      <input id="payout-transfer" className="input font-mono" maxLength={PAYOUT_TRANSFER_ID_MAX} autoComplete="off" value={transferId} onChange={(event) => setTransferId(event.target.value)} />
      <label htmlFor="payout-paid" className="field-label mt-4">
        {d.paid}
      </label>
      <input
        id="payout-paid"
        className="input font-mono"
        type="number"
        inputMode="decimal"
        min={0.01}
        max={Math.floor(max) / 100}
        step={0.01}
        placeholder={(Math.floor(max) / 100).toFixed(2)}
        value={paid}
        onChange={(event) => setPaid(event.target.value)}
      />
      <small className="hint block">{fill(d.paidHint, { max: usd(max) })}</small>
      <div className="mt-3 flex items-center justify-between gap-2 rounded-lg bg-wash px-3 py-2.5 text-[12px]">
        <span className="text-muted">{d.fee}</span>
        <strong className="font-mono" aria-live="polite">
          {fee === null ? '—' : usd(fee)}
        </strong>
      </div>
      <div className="my-5 border-t border-line" />
      <label htmlFor="payout-failure" className="field-label">
        {d.failure}
      </label>
      <textarea id="payout-failure" rows={3} maxLength={ADMIN_REASON.max} placeholder={d.failurePlaceholder} value={reason} onChange={(event) => setReason(event.target.value)} className="input resize-y" />
      {!allowed && <p className="mt-3 rounded-lg bg-[#fff3f3] px-3 py-2 text-[12px] text-red">{d.paymentPaused}</p>}
      {error && (
        <p role="alert" className="mt-3 text-[12px] text-red">
          {error}
        </p>
      )}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          className="btn-secondary"
          disabled={busy !== null}
          onClick={() => {
            if (reasonLength(reason) < ADMIN_REASON.min || reasonLength(reason) > ADMIN_REASON.max) return setError(errors.reason!);
            void run('failed', `/api/admin/payouts/${id}/failed`, { reason: reason.trim() }, d.failedDone);
          }}
        >
          {busy === 'failed' && <Spinner />}
          {d.markFailed}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy !== null || !allowed}
          onClick={() => {
            if (!transferId.trim()) return setError(errors.transfer_id!);
            if (fee === null) return setError(errors.paid_amount!);
            void run('paid', `/api/admin/payouts/${id}/paid`, { transferId: transferId.trim(), paid }, d.paidDone);
          }}
        >
          {busy === 'paid' ? <Spinner /> : <Icon name="check" className="size-4" />}
          {d.markPaid}
        </button>
      </div>
    </form>
  );
}
