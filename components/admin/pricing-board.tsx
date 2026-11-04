'use client';
import { useState, type FormEvent } from 'react';
import { PageHead } from '@/components/admin/list-kit';
import { CI } from '@/components/admin/console-icon';
import { useI18n } from '@/i18n/client';
import { formatNumber, formatUsd } from '@/i18n/format';
import './pricing-board.css';
import type { PricingView, PriceView, WelcomeCreditsView } from '@/lib/domain/pricing';

// datetime-local uses the explicitly labelled business timezone, regardless of the browser timezone.
const localTime = (iso: string) => new Date(Date.parse(iso) + 8 * 3600_000).toISOString().slice(0, 16);
const utcTime = (value: string) => (value ? new Date(`${value}:00+08:00`).toISOString() : '');

export function PricingBoard({ initial, configured, welcome }: { initial: PricingView; configured: boolean; welcome: WelcomeCreditsView }) {
  const { t } = useI18n();
  const p = t.pricingAdmin;
  return (
    <div className="console-body">
      <PageHead title={p.title} lede={p.description} />
      <div className="info-strip mb16">
        <CI name="info" />
        <span>{p.note}</span>
      </div>
      {!configured && <p role="status">{p.unavailable}</p>}
      <WelcomeCreditsForm initial={welcome} />
      <div className="pricing-admin-grid">
        {(['plan', 'pack'] as const).map((kind) => (
          <PriceForm key={kind} kind={kind} initial={initial[kind]} configured={configured} />
        ))}
      </div>
    </div>
  );
}
function PriceForm({ kind, initial, configured }: { kind: 'plan' | 'pack'; initial: PriceView; configured: boolean }) {
  const { t, locale } = useI18n();
  const p = t.pricingAdmin;
  const [price, setPrice] = useState(initial);
  const [regular, setRegular] = useState(String(initial.priceMinor / 100));
  const [enabled, setEnabled] = useState(Boolean(initial.promotion));
  const [promo, setPromo] = useState(initial.promotion ? String(initial.promotion.priceMinor / 100) : '');
  const [start, setStart] = useState(initial.promotion ? localTime(initial.promotion.startsAt) : '');
  const [end, setEnd] = useState(initial.promotion ? localTime(initial.promotion.endsAt) : '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      const cents = (s: string) => (/^\d+(?:\.\d{1,2})?$/.test(s) ? Math.round(Number(s) * 100) : NaN);
      const response = await fetch('/api/admin/pricing', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind,
          revision: price.revision,
          priceMinor: cents(regular),
          promotion: enabled ? { priceMinor: cents(promo), startsAt: utcTime(start), endsAt: utcTime(end) } : null,
        }),
      });
      const result = (await response.json()) as { price?: PriceView; error?: keyof typeof p.errors };
      if (!response.ok || !result.price) {
        setMessage((result.error && p.errors[result.error]) || t.common.errors.generic);
        return;
      }
      setPrice(result.price);
      setMessage(p.saved);
    } catch {
      setMessage(t.common.errors.network);
    } finally {
      setBusy(false);
    }
  }
  const status = price.promotion
    ? price.promotional
      ? p.active
      : Date.parse(price.promotion.endsAt) <= Date.now()
        ? p.ended
        : p.scheduled
    : null;
  return (
    <form className="card pricing-admin-card" onSubmit={save}>
      <div className="between">
        <h2>{kind === 'plan' ? 'Plan' : 'Pack'}</h2>
        {status && <span className="tag">{status}</span>}
      </div>
      <p>
        {p.current}: <strong>{formatUsd(price.effectivePriceMinor, locale)}</strong>
      </p>
      <fieldset disabled={busy || !configured} className="grid gap-4">
        <label className="grid gap-2">
          {p.regular}
          <input
            className="input"
            type="number"
            min="0.01"
            max="1000000"
            step="0.01"
            required
            value={regular}
            onChange={(e) => setRegular(e.target.value)}
          />
        </label>
        <label className="flex gap-2 items-center">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          {p.promotion}
        </label>
        {enabled && (
          <>
            <label className="grid gap-2">
              {p.promotional}
              <input
                className="input"
                type="number"
                min="0.01"
                max="1000000"
                step="0.01"
                required
                value={promo}
                onChange={(e) => setPromo(e.target.value)}
              />
            </label>
            <label className="grid gap-2">
              {p.startsAt}
              <input className="input" type="datetime-local" required value={start} onChange={(e) => setStart(e.target.value)} />
            </label>
            <label className="grid gap-2">
              {p.endsAt}
              <input className="input" type="datetime-local" required value={end} onChange={(e) => setEnd(e.target.value)} />
            </label>
          </>
        )}
        <button className="btn" type="submit">
          {busy ? p.saving : p.save}
        </button>
      </fieldset>
      {message && <p role="status">{message}</p>}
    </form>
  );
}

function WelcomeCreditsForm({ initial }: { initial: WelcomeCreditsView }) {
  const { t, locale } = useI18n();
  const p = t.pricingAdmin;
  const [saved, setSaved] = useState(initial);
  const [amount, setAmount] = useState(String(initial.credits));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      const credits = /^\d+$/.test(amount) ? Number(amount) : null;
      const response = await fetch('/api/admin/pricing', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'welcome', credits, revision: saved.revision }),
      });
      const result = (await response.json()) as { welcome?: WelcomeCreditsView; error?: keyof typeof p.errors };
      if (!response.ok || !result.welcome) {
        setMessage((result.error && p.errors[result.error]) || t.common.errors.generic);
        return;
      }
      setSaved(result.welcome);
      setMessage(p.welcome.saved);
    } catch {
      setMessage(t.common.errors.network);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="card pricing-admin-card pricing-welcome-card" onSubmit={save}>
      <div>
        <h2>{p.welcome.title}</h2>
        <p className="muted">{p.welcome.note}</p>
      </div>
      <p>
        {p.welcome.current}: <strong>{formatNumber(saved.credits, locale)} credits</strong>
      </p>
      <fieldset disabled={busy}>
        <label>
          {p.welcome.amount}
          <input
            className="input"
            type="number"
            required
            min="0"
            max="100000000"
            step="1"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        <button className="btn" type="submit">
          {busy ? p.saving : p.welcome.save}
        </button>
      </fieldset>
      {message && <p role="status">{message}</p>}
    </form>
  );
}
