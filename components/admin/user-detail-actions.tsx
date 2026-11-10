'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { CREDIT_ADJUSTMENT, ADMIN_REASON } from '@/lib/constants';
import { api } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber } from '@/i18n/format';
import { CI } from '@/components/admin/console-icon';
import { ConfirmModal, Modal } from '@/components/admin/console-modal';
import { useToast } from '@/components/ui/toast';

function useErrorText() {
  const { t } = useI18n();
  return (code: string | undefined, own: Record<string, string> = {}) =>
    (code && (own[code] ?? (t.console.errors as Record<string, string>)[code])) || t.console.errors.generic;
}

/** 停用账号 / 恢复账号 (prototype 'toggle-user'): a confirmation, then the status endpoint. */
export function UserStatusButton({ id, disabled, className = 'btn secondary full mt16' }: { id: string; disabled: boolean; className?: string }) {
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
      <button type="button" className={className} onClick={() => (setError(''), setOpen(true))}>
        {disabled ? d.actions.restore : d.actions.disable}
      </button>
      <ConfirmModal
        open={open}
        title={disabled ? d.toggle.restoreTitle : d.toggle.disableTitle}
        body={
          <>
            {error && (
              <span className="form-error" role="alert">
                {error}
              </span>
            )}
            {disabled ? d.toggle.restoreBody : d.toggle.disableBody}
          </>
        }
        confirmLabel={d.toggle.confirm}
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

/**
 * 调整 Credits (prototype `adjustModal`): grant or deduct, Pack or Plan,
 * 1–10,000,000 whole credits and a 3–300 character reason. A Plan grant
 * needs an active Plan, so that option is closed without one.
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
        className="btn full mt24"
        onClick={() => {
          setError('');
          setBucket('pack');
          setDirection('grant');
          setOpen(true);
        }}
      >
        <CI name="plus" />
        {t.consoleUsers.detail.actions.adjust}
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={a.title}
        subtitle={`${name} · ${email}`}
        footer={
          <>
            <button type="button" className="btn secondary" onClick={() => setOpen(false)}>
              {t.common.actions.cancel}
            </button>
            <button type="submit" form="adjust-form" className="btn" disabled={busy}>
              {busy && <span className="spinner" aria-hidden="true" />}
              {a.confirm}
            </button>
          </>
        }
      >
        <form
          id="adjust-form"
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
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          <div className="field">
            <label htmlFor="credit-direction">{a.direction}</label>
            <select
              id="credit-direction"
              name="direction"
              value={direction}
              onChange={(event) => {
                const value = event.target.value === 'deduct' ? 'deduct' : 'grant';
                setDirection(value);
                if (value === 'grant' && !planActive) setBucket('pack');
              }}
            >
              <option value="grant">{a.grant}</option>
              <option value="deduct">{a.deduct}</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="credit-bucket">{a.bucket}</label>
            <select id="credit-bucket" name="bucket" value={bucket} onChange={(event) => setBucket(event.target.value === 'plan' ? 'plan' : 'pack')}>
              <option value="pack">{a.pack}</option>
              <option value="plan" disabled={planLocked}>
                {a.plan}
              </option>
            </select>
            {planLocked && <small>{a.noPlan}</small>}
          </div>
          <div className="field">
            <label htmlFor="credit-amount">{a.amount}</label>
            <input
              id="credit-amount"
              name="amount"
              type="number"
              inputMode="numeric"
              min={CREDIT_ADJUSTMENT.min}
              max={CREDIT_ADJUSTMENT.max}
              step={1}
              required
            />
            <small>{a.amountHint}</small>
          </div>
          <div className="field">
            <label htmlFor="credit-reason">{a.reason}</label>
            <textarea
              id="credit-reason"
              name="reason"
              rows={3}
              required
              minLength={ADMIN_REASON.min}
              maxLength={ADMIN_REASON.max}
              placeholder={a.placeholder}
            />
          </div>
          <div className="info-strip">
            <CI name="shield" />
            <span>{a.info}</span>
          </div>
        </form>
      </Modal>
    </>
  );
}

/** 强制吊销 one of the user's API keys: a confirmation, then the audited revoke. */
export function ApiKeyRevokeButton({ userId, userName, keyId, keyLabel }: { userId: string; userName: string; keyId: string; keyLabel: string }) {
  const { t } = useI18n();
  const a = t.apiKeys.admin;
  const router = useRouter();
  const toast = useToast();
  const errorText = useErrorText();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <>
      <button type="button" className="btn secondary sm" onClick={() => (setError(''), setOpen(true))}>
        {a.revoke}
      </button>
      <ConfirmModal
        open={open}
        title={a.revokeTitle}
        body={
          <>
            {error && (
              <span className="form-error" role="alert">
                {error}
              </span>
            )}
            {fill(a.revokeBody, { name: userName, key: keyLabel })}
          </>
        }
        confirmLabel={a.revoke}
        danger
        busy={busy}
        onClose={() => setOpen(false)}
        onConfirm={async () => {
          setBusy(true);
          setError('');
          const result = await api<{ error?: string }>(`/api/admin/users/${userId}/api-keys/${keyId}`, { method: 'DELETE' });
          setBusy(false);
          if (!result.ok) {
            setError(errorText(result.data.error));
            return;
          }
          setOpen(false);
          toast(a.revoked);
          router.refresh();
        }}
      />
    </>
  );
}
