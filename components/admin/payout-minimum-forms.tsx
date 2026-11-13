'use client';

import { useState, type FormEvent } from 'react';
import { useNavigationRouter as useRouter } from '@/components/shell/navigation-provider';
import { PAYOUT_MIN_BOUNDS } from '@/lib/constants';
import { formatCreditsUsd } from '@/lib/domain/payouts';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber } from '@/i18n/format';
import './pricing-board.css';

type ErrorCode = 'invalid_payout_minimum' | 'pricing_conflict' | 'not_found';
const whole = (value: string) => (/^\d+$/.test(value.trim()) ? Number(value.trim()) : null);

/** The site-wide payout minimum on the payout review page (lib/services/payout-minimum.ts `saveSitePayoutMinimum`). */
export function SitePayoutMinimumForm({ initial }: { initial: { credits: number; revision: string } }) {
  const { t } = useI18n();
  const m = t.consolePayouts.minimum;
  const router = useRouter();
  const [saved, setSaved] = useState(initial);
  const [value, setValue] = useState(String(initial.credits));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch('/api/admin/payout-settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ credits: whole(value), revision: saved.revision }),
      });
      const result = (await response.json()) as { minimum?: { credits: number; revision: string }; error?: ErrorCode };
      if (!response.ok || !result.minimum) {
        setMessage((result.error && m.errors[result.error]) || t.common.errors.generic);
        return;
      }
      setSaved(result.minimum);
      setMessage(m.saved);
      router.refresh();
    } catch {
      setMessage(t.common.errors.network);
    } finally {
      setBusy(false);
    }
  }
  const amount = whole(value);
  return (
    <form className="card pricing-admin-card pricing-credit-card payout-minimum-form" onSubmit={save}>
      <div>
        <h2>{m.title}</h2>
        <p className="muted">
          {m.siteHint}
          {saved.revision === 'default' && (
            <>
              <br />
              {m.defaults}
            </>
          )}
        </p>
      </div>
      <fieldset disabled={busy}>
        <label className="grid gap-2">
          {m.site}
          <input
            className="input"
            type="number"
            inputMode="numeric"
            required
            min={PAYOUT_MIN_BOUNDS.min}
            max={PAYOUT_MIN_BOUNDS.max}
            step="1"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          {amount !== null && <small className="muted">{fill(m.usd, { usd: formatCreditsUsd(amount) })}</small>}
        </label>
        <button className="btn" type="submit">
          {busy ? m.saving : m.save}
        </button>
      </fieldset>
      {message && <p role="status">{message}</p>}
    </form>
  );
}

/** One user's own payout minimum on the console's user page: set it, or clear it back to the site-wide one. */
export function UserPayoutMinimumForm({ userId, override, site }: { userId: string; override: number | null; site: number }) {
  const { t, locale } = useI18n();
  const m = t.consolePayouts.minimum;
  const router = useRouter();
  const [current, setCurrent] = useState(override);
  const [value, setValue] = useState(String(override ?? site));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const n = (credits: number) => formatNumber(credits, locale);
  async function send(credits: number | null) {
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch(`/api/admin/users/${userId}/payout-minimum`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ credits }),
      });
      const result = (await response.json()) as { credits?: number | null; error?: ErrorCode };
      if (!response.ok || result.credits === undefined) {
        setMessage((result.error && m.errors[result.error]) || t.common.errors.generic);
        return;
      }
      setCurrent(result.credits);
      if (result.credits === null) setValue(String(site));
      setMessage(m.saved);
      router.refresh();
    } catch {
      setMessage(t.common.errors.network);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="payout-minimum-user"
      onSubmit={(event) => {
        event.preventDefault();
        void send(whole(value));
      }}
    >
      <strong>{current === null ? fill(m.userDefault, { n: n(site) }) : fill(m.userOverride, { n: n(current) })}</strong>
      <p className="muted">{m.userHint}</p>
      <fieldset disabled={busy} className="flex gap-2 items-center">
        <input
          className="input"
          type="number"
          inputMode="numeric"
          required
          min={PAYOUT_MIN_BOUNDS.min}
          max={PAYOUT_MIN_BOUNDS.max}
          step="1"
          aria-label={m.user}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button className="btn sm" type="submit">
          {m.set}
        </button>
        {current !== null && (
          <button className="btn secondary sm" type="button" onClick={() => void send(null)}>
            {m.clear}
          </button>
        )}
      </fieldset>
      {message && <p role="status">{message}</p>}
    </form>
  );
}
