'use client';

import { useState, type FormEvent } from 'react';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { useNavigationRouter as useRouter } from '@/components/shell/navigation-provider';
import { REWARD_NUMBER_BOUNDS, REWARD_NUMBER_FIELDS, rewardNumberMin, type RewardNumberField, type RewardSettings } from '@/lib/domain/invites';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber } from '@/i18n/format';
import './pricing-board.css';

/** The 邀请与任务 settings (lib/services/invites.ts `saveRewardSettings`): one form, one revision, one audit entry. */
export function InvitesForm({ initial, welcomeCredits }: { initial: RewardSettings; welcomeCredits: number }) {
  const { t, locale } = useI18n();
  const a = t.invites.admin;
  const f = a.form;
  const router = useRouter();
  const [saved, setSaved] = useState(initial);
  const [enabled, setEnabled] = useState(initial.invitesEnabled);
  const [values, setValues] = useState<Record<RewardNumberField, string>>(
    () => Object.fromEntries(REWARD_NUMBER_FIELDS.map((field) => [field, String(initial[field])])) as Record<RewardNumberField, string>,
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      const whole = (value: string) => (/^\d+$/.test(value.trim()) ? Number(value.trim()) : null);
      const response = await fetch('/api/admin/invites', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revision: saved.revision, invitesEnabled: enabled, ...Object.fromEntries(REWARD_NUMBER_FIELDS.map((field) => [field, whole(values[field])])) }),
      });
      const result = (await response.json()) as { settings?: RewardSettings; error?: keyof typeof a.errors };
      if (!response.ok || !result.settings) {
        setMessage((result.error && a.errors[result.error]) || t.common.errors.generic);
        return;
      }
      setSaved(result.settings);
      setMessage(f.saved);
      router.refresh();
    } catch {
      setMessage(t.common.errors.network);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="card pricing-admin-card pricing-credit-card invites-form" onSubmit={save}>
      <div>
        <h2>{f.title}</h2>
        <p className="muted">
          {fill(f.signup, { n: formatNumber(welcomeCredits, locale) })} ·{' '}
          <Link href="/admin/pricing" className="text-link">
            {f.signupLink}
          </Link>
          {saved.revision === 'default' && <> · {f.defaults}</>}
        </p>
      </div>
      <fieldset disabled={busy} className="grid gap-4">
        <label className="flex gap-2 items-center">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          {f.invitesEnabled}
        </label>
        {REWARD_NUMBER_FIELDS.map((field) => (
          <label className="grid gap-2" key={field}>
            {f[field]}
            <input
              className="input"
              type="number"
              inputMode="numeric"
              required
              min={rewardNumberMin(field)}
              max={REWARD_NUMBER_BOUNDS[field]}
              step="1"
              value={values[field]}
              onChange={(e) => setValues({ ...values, [field]: e.target.value })}
            />
            {field === 'withdrawableInvites' && <small className="muted">{f.withdrawableInvitesHint}</small>}
            {field === 'withdrawableInvitesPerInviter' && <small className="muted">{f.withdrawableInvitesPerInviterHint}</small>}
          </label>
        ))}
        <button className="btn" type="submit">
          {busy ? f.saving : f.save}
        </button>
      </fieldset>
      {message && <p role="status">{message}</p>}
    </form>
  );
}
