'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { CREDIT_ADJUSTMENT, ADMIN_REASON } from '@/lib/constants';
import { api } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber } from '@/i18n/format';
import { Icon, Spinner } from '@/components/ui/icons';
import { ConfirmModal, Modal } from '@/components/ui/modal';
import { useToast } from '@/components/ui/toast';

function useErrorText() {
  const { t } = useI18n();
  return (code: string | undefined, own: Record<string, string> = {}) =>
    (code && (own[code] ?? (t.console.errors as Record<string, string>)[code])) || t.console.errors.generic;
}

/** 停用 / 恢复 (prototype 'toggle-user'): a confirmation, then the status endpoint. */
export function UserStatusButton({ id, disabled }: { id: string; disabled: boolean }) {
  const { t } = useI18n();
  const d = t.consoleUsers.detail;
  const router = useRouter();
  const toast = useToast();
  const errorText = useErrorText();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <>
      <button type="button" className={disabled ? 'btn-secondary btn-sm' : 'btn-danger btn-sm'} onClick={() => (setError(''), setOpen(true))}>
        <Icon name={disabled ? 'refresh' : 'lock'} className="size-3.5" />
        {disabled ? d.actions.restore : d.actions.disable}
      </button>
      <ConfirmModal
        open={open}
        title={disabled ? d.toggle.restoreTitle : d.toggle.disableTitle}
        body={
          <>
            {disabled ? d.toggle.restoreBody : d.toggle.disableBody}
            {error && (
              <p role="alert" className="mt-3 text-[12px] text-red">
                {error}
              </p>
            )}
          </>
        }
        confirmLabel={d.toggle.confirm}
        danger={!disabled}
        busy={busy}
        onClose={() => setOpen(false)}
        onConfirm={async () => {
          setBusy(true);
          setError('');
          const result = await api<{ error?: string }>(`/api/admin/users/${id}/status`, { method: 'POST', json: { disabled: !disabled } });
          setBusy(false);
          if (!result.ok) {
            setError(errorText(result.data.error));
            return;
          }
          setOpen(false);
          toast(disabled ? d.toggle.restored : d.toggle.disabled);
          router.refresh();
        }}
      />
    </>
  );
}

const choice =
  'flex min-w-0 flex-1 cursor-pointer items-start gap-2 rounded-lg border border-line px-3 py-2.5 text-[13px] has-[:checked]:border-blue has-[:checked]:bg-soft has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50';

/**
 * 调整 credits (prototype `adjustModal`): Pack or Plan, grant or deduct,
 * 1–10,000,000 whole credits and a 3–300 character reason. A Plan grant
 * needs an active Plan, so the choice is closed without one.
 */
export function AdjustCreditsButton({ id, name, email, planActive }: { id: string; name: string; email: string; planActive: boolean }) {
  const { t, locale } = useI18n();
  const a = t.consoleUsers.detail.adjust;
  const router = useRouter();
  const toast = useToast();
  const errorText = useErrorText();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [bucket, setBucket] = useState<'pack' | 'plan'>('pack');
  const [direction, setDirection] = useState<'grant' | 'deduct'>('grant');
  const planLocked = direction === 'grant' && !planActive;
  return (
    <>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => {
          setError('');
          setBucket('pack');
          setDirection('grant');
          setOpen(true);
        }}
      >
        <Icon name="plus" className="size-3.5" />
        {t.consoleUsers.detail.actions.adjust}
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={a.title}
        subtitle={`${name} · ${email}`}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>
              {t.common.actions.cancel}
            </button>
            <button type="submit" form="adjust-credits-form" className="btn" disabled={busy}>
              {busy && <Spinner />}
              {a.confirm}
            </button>
          </>
        }
      >
        <form
          id="adjust-credits-form"
          noValidate
          onSubmit={async (event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const amount = Number(String(form.get('amount') ?? '').replaceAll(',', '').trim());
            const reason = String(form.get('reason') ?? '').trim();
            const length = Array.from(reason).length;
            if (!Number.isInteger(amount) || amount < CREDIT_ADJUSTMENT.min || amount > CREDIT_ADJUSTMENT.max) return setError(a.errors.amount);
            if (length < ADMIN_REASON.min || length > ADMIN_REASON.max) return setError(a.errors.reason);
            if (bucket === 'plan' && planLocked) return setError(a.errors.no_plan);
            setBusy(true);
            setError('');
            const result = await api<{ error?: string; delta?: number }>(`/api/admin/users/${id}/credits`, {
              method: 'POST',
              json: { bucket, direction, amount, reason },
            });
            setBusy(false);
            if (!result.ok) return setError(errorText(result.data.error, a.errors));
            setOpen(false);
            const delta = result.data.delta ?? (direction === 'grant' ? amount : -amount);
            toast(fill(a.done, { delta: `${delta > 0 ? '+' : ''}${formatNumber(delta, locale)}` }));
            router.refresh();
          }}
        >
          <fieldset className="mb-4">
            <legend className="field-label">{a.direction}</legend>
            <div className="flex flex-wrap gap-2">
              {(['grant', 'deduct'] as const).map((value) => (
                <label key={value} className={choice}>
                  <input
                    type="radio"
                    name="direction"
                    value={value}
                    checked={direction === value}
                    onChange={() => {
                      setDirection(value);
                      if (value === 'grant' && !planActive) setBucket('pack');
                    }}
                    className="mt-0.5"
                  />
                  <span className="font-semibold">{value === 'grant' ? a.grant : a.deduct}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="mb-4">
            <legend className="field-label">{a.bucket}</legend>
            <div className="flex flex-wrap gap-2">
              {(['pack', 'plan'] as const).map((value) => (
                <label key={value} className={choice}>
                  <input
                    type="radio"
                    name="bucket"
                    value={value}
                    checked={bucket === value}
                    disabled={value === 'plan' && planLocked}
                    onChange={() => setBucket(value)}
                    className="mt-0.5"
                  />
                  <span className="min-w-0">
                    <span className="block font-semibold">{value === 'pack' ? a.pack : a.plan}</span>
                    <small className="block text-[11px] text-muted">{value === 'pack' ? a.packHint : a.planHint}</small>
                  </span>
                </label>
              ))}
            </div>
            {planLocked && <small className="hint mt-1.5 block">{a.noPlan}</small>}
          </fieldset>
          <label htmlFor="adjust-amount" className="field-label">
            {a.amount}
          </label>
          <input
            id="adjust-amount"
            name="amount"
            type="number"
            inputMode="numeric"
            min={CREDIT_ADJUSTMENT.min}
            max={CREDIT_ADJUSTMENT.max}
            step={1}
            required
            className="input"
          />
          <small className="hint mb-4 block">{a.amountHint}</small>
          <label htmlFor="adjust-reason" className="field-label">
            {a.reason}
          </label>
          <textarea
            id="adjust-reason"
            name="reason"
            rows={3}
            required
            minLength={ADMIN_REASON.min}
            maxLength={ADMIN_REASON.max}
            placeholder={a.placeholder}
            className="input resize-y"
          />
          <small className="hint block">{fill(t.console.reason.hint, { min: ADMIN_REASON.min, max: ADMIN_REASON.max })}</small>
          <div className="mt-4 flex items-start gap-2 rounded-lg bg-soft px-3 py-2.5 text-[12px] leading-relaxed text-blue">
            <Icon name="shield" className="mt-0.5 size-4 flex-none" />
            <span>{a.info}</span>
          </div>
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
