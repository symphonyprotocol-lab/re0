'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { PAYOUT_MIN_CREDITS, PAYPAL_EMAIL_MAX } from '@/lib/constants';
import { formatCreditsUsd as usd } from '@/lib/domain/payouts';
import { api } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { fill, formatDate, formatNumber } from '@/i18n/format';
import { Icon, Spinner } from '@/components/ui/icons';
import { Modal } from '@/components/ui/modal';
import { useToast } from '@/components/ui/toast';


/** "绑定 / 更换" the PayPal e-mail (prototype `paypalModal`); a change starts the seven-day hold. */
export function PaypalButton({ email, disabled }: { email: string | null; disabled: boolean }) {
  const { t, locale } = useI18n();
  const p = t.payouts.paypal;
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(email ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    setBusy(true);
    setError('');
    const result = await api<{ email?: string; holdUntil?: string | null; error?: string }>('/api/billing/paypal', { method: 'PUT', json: { email: value } });
    setBusy(false);
    if (!result.ok) {
      setError((p.errors as Record<string, string>)[result.data.error ?? ''] ?? p.errors.generic);
      return;
    }
    setOpen(false);
    const until = result.data.holdUntil;
    toast(until && result.data.email !== email ? fill(p.changed, { date: formatDate(until, locale) }) : p.saved);
    router.refresh();
  }

  return (
    <>
      <button type="button" className="btn-secondary btn-sm flex-none" disabled={disabled} onClick={() => (setValue(email ?? ''), setError(''), setOpen(true))}>
        {email ? t.payouts.card.change : t.payouts.card.connect}
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={p.title}
        subtitle={p.lede}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>
              {p.cancel}
            </button>
            <button type="submit" form="paypal-form" className="btn" disabled={busy}>
              {busy && <Spinner />}
              {p.save}
            </button>
          </>
        }
      >
        <form
          id="paypal-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label htmlFor="paypal-email" className="field-label">
            {p.email}
          </label>
          <input id="paypal-email" type="email" className="input" required maxLength={PAYPAL_EMAIL_MAX} autoComplete="email" value={value} onChange={(event) => setValue(event.target.value)} />
          <p className="mt-4 flex items-start gap-2 rounded-lg bg-wash px-3 py-2.5 text-[12px] leading-relaxed text-muted">
            <Icon name="shield" className="mt-0.5 size-4 flex-none text-blue" />
            {p.note}
          </p>
          {error && (
            <p role="alert" className="mt-3 text-[12px] text-red">
              {error}
            </p>
          )}
        </form>
      </Modal>
    </>
  );
}

/** "申请提现" (prototype `payoutModal`): whole credits from 500,000 up to the earned balance, all of it by default. */
export function RequestPayoutButton({ withdrawable, email, enabled }: { withdrawable: number; email: string | null; enabled: boolean }) {
  const { t, locale } = useI18n();
  const r = t.payouts.request;
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [credits, setCredits] = useState(String(withdrawable));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const n = (value: number) => formatNumber(value, locale);
  const amount = Number(credits);

  async function submit() {
    setBusy(true);
    setError('');
    const result = await api<{ error?: string }>('/api/billing/payouts', { method: 'POST', json: { credits: amount } });
    setBusy(false);
    if (!result.ok) {
      const message = (r.errors as Record<string, string>)[result.data.error ?? ''] ?? r.errors.generic;
      setError(fill(message, { min: n(PAYOUT_MIN_CREDITS) }));
      return;
    }
    setOpen(false);
    toast(r.done);
    router.refresh();
  }

  return (
    <>
      <button type="button" className="btn flex-none" disabled={!enabled} onClick={() => (setCredits(String(withdrawable)), setError(''), setOpen(true))}>
        {t.payouts.card.request}
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={r.title}
        subtitle={r.lede}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>
              {r.cancel}
            </button>
            <button type="submit" form="payout-form" className="btn" disabled={busy}>
              {busy && <Spinner />}
              {r.submit}
            </button>
          </>
        }
      >
        <form
          id="payout-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label htmlFor="payout-credits" className="field-label">
            {r.credits}
          </label>
          <input
            id="payout-credits"
            type="number"
            inputMode="numeric"
            className="input font-mono"
            required
            min={PAYOUT_MIN_CREDITS}
            max={withdrawable}
            step={1}
            value={credits}
            onChange={(event) => setCredits(event.target.value)}
          />
          <small className="hint">
            {fill(r.creditsHint, { min: n(PAYOUT_MIN_CREDITS), usd: usd(PAYOUT_MIN_CREDITS), max: n(withdrawable) })}
            {Number.isInteger(amount) && amount > 0 && ` · ${fill(r.equals, { usd: usd(amount) })}`}
          </small>
          <div className="mt-4 flex min-w-0 items-center justify-between gap-3 rounded-lg border border-line px-3 py-2.5 text-[12px]">
            <span className="flex-none text-muted">{r.email}</span>
            <strong className="min-w-0 truncate" title={email ?? ''}>
              {email}
            </strong>
          </div>
          <p className="mt-4 flex items-start gap-2 rounded-lg bg-wash px-3 py-2.5 text-[12px] leading-relaxed text-muted">
            <Icon name="info" className="mt-0.5 size-4 flex-none text-blue" />
            {r.note}
          </p>
          {error && (
            <p role="alert" className="mt-3 text-[12px] text-red">
              {error}
            </p>
          )}
        </form>
      </Modal>
    </>
  );
}
