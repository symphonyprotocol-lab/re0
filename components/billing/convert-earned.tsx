'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber } from '@/i18n/format';
import { convertedCredits } from '@/lib/domain/earned';
import { Modal } from '@/components/ui/modal';
import { useToast } from '@/components/ui/toast';
import { Spinner } from '@/components/ui/icons';

/**
 * The Earned card's "转换为可用点数" (docs/design/earned-credits.md): how many
 * earned credits, what they become at the console's rate, and what is left
 * to withdraw. The order earned credits are taken in (never-withdrawable
 * first, withdrawable last) is the server's; the preview follows it.
 */
export function ConvertEarned({
  earned,
  withdrawable,
  maturing,
  locked,
  rateBp,
  minimum,
  enabled,
}: {
  earned: number;
  withdrawable: number;
  maturing: number;
  locked: number;
  rateBp: number;
  minimum: number;
  enabled: boolean;
}) {
  const { t, locale } = useI18n();
  const c = t.billing.convert;
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  /* What cannot be withdrawn now (paid with free credits, or still maturing) is offered first; withdrawable earnings only if the user types them in. */
  const suggested = locked + maturing >= minimum ? String(locked + maturing) : '';
  const [raw, setRaw] = useState(suggested);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const n = (value: number) => formatNumber(value, locale);

  const amount = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  const valid = Number.isSafeInteger(amount) && amount >= minimum && amount <= earned;
  const counted = Number.isSafeInteger(amount) ? Math.min(Math.max(amount, 0), earned) : 0;
  /* Never-withdrawable and maturing earnings go first; what is withdrawable now goes last. */
  const fromWithdrawable = Math.max(0, counted - locked - maturing);

  const submit = async () => {
    setError(null);
    if (!valid) {
      setError(amount < minimum ? fill(c.errors.below_minimum, { min: n(minimum) }) : c.errors.invalid_amount);
      return;
    }
    setBusy(true);
    try {
      const response = await fetch('/api/billing/earned/convert', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ credits: amount, rateBp }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: keyof typeof c.errors; converted?: number; received?: number; offset?: number };
      if (!response.ok) {
        if (body.error === 'rate_changed') router.refresh();
        setError(body.error ? fill(c.errors[body.error] ?? t.common.errors.generic, { min: n(minimum) }) : t.common.errors.generic);
        return;
      }
      const offset = body.offset ?? 0;
      toast(fill(offset > 0 ? c.doneOffset : c.done, { earned: n(body.converted ?? amount), credits: n(body.received ?? 0), offset: n(offset) }));
      setOpen(false);
      router.refresh();
    } catch {
      setError(t.common.errors.network);
    } finally {
      setBusy(false);
    }
  };

  if (earned <= 0) return null;
  return (
    <>
      <button
        type="button"
        className="btn small earned-convert"
        disabled={!enabled}
        title={enabled ? undefined : c.disabled}
        onClick={() => {
          setRaw(suggested);
          setError(null);
          setOpen(true);
        }}
      >
        {t.billing.total.earned.convert}
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={c.title}
        footer={
          <>
            <button type="button" className="btn secondary" onClick={() => setOpen(false)}>
              {c.cancel}
            </button>
            <button type="button" className="btn" disabled={busy || !valid} onClick={submit}>
              {busy && <Spinner />}
              {busy ? c.working : c.confirm}
            </button>
          </>
        }
      >
        <div className="earned-convert-form">
          <label className="field">
            <span className="field-label">{c.amount}</span>
            <span className="earned-convert-input">
              <input
                id="earned-convert-amount"
                inputMode="numeric"
                value={raw}
                onChange={(event) => setRaw(event.target.value.replace(/[^\d]/g, ''))}
                aria-invalid={!valid}
              />
              <button type="button" className="text-link" onClick={() => setRaw(String(earned))}>
                {c.all}
              </button>
            </span>
          </label>
          <dl className="earned-convert-calc">
            <dt>{c.rate}</dt>
            <dd>{fill(c.rateValue, { n: String(rateBp / 10_000) })}</dd>
            <dt>{c.receive}</dt>
            <dd className="strong">+{n(convertedCredits(counted, rateBp))}</dd>
            <dt>{c.earnedLeft}</dt>
            <dd>{n(earned - counted)}</dd>
            <dt>{c.withdrawableLeft}</dt>
            <dd>{n(withdrawable - Math.min(withdrawable, fromWithdrawable))}</dd>
          </dl>
          <p className="small muted">{fill(c.note, { min: n(minimum) })}</p>
          {error && (
            <p role="alert" className="small earned-convert-error">
              {error}
            </p>
          )}
        </div>
      </Modal>
    </>
  );
}
