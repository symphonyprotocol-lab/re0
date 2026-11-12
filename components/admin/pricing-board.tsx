'use client';
import { useState, type FormEvent } from 'react';
import { PageHead } from '@/components/admin/list-kit';
import { CI } from '@/components/admin/console-icon';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber, formatUsd } from '@/i18n/format';
import './pricing-board.css';
import type { PricingView, PriceView, CreditAmountView } from '@/lib/domain/pricing';
import type { InfraCostRatesView } from '@/lib/domain/infra-cost';
import { ANONYMOUS_LIMIT_BOUNDS, ANONYMOUS_LIMIT_FIELDS, type AnonymousChatLimits, type AnonymousLimitField } from '@/lib/domain/anonymous-chat';

// datetime-local uses the explicitly labelled business timezone, regardless of the browser timezone.
const localTime = (iso: string) => new Date(Date.parse(iso) + 8 * 3600_000).toISOString().slice(0, 16);
const utcTime = (value: string) => (value ? new Date(`${value}:00+08:00`).toISOString() : '');

export function PricingBoard({ initial, configured, welcome, videoScript, videoExport, infraCosts, anonymousChat, anonymousToday }: {
  initial: PricingView;
  configured: boolean;
  welcome: CreditAmountView;
  videoScript: CreditAmountView;
  videoExport: CreditAmountView;
  infraCosts: InfraCostRatesView;
  anonymousChat: AnonymousChatLimits;
  /** Today's (UTC) anonymous answers over the platform. */
  anonymousToday: number;
}) {
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
      <CreditAmountForm kind="welcome" initial={welcome} />
      <CreditAmountForm kind="video_script" initial={videoScript} />
      <CreditAmountForm kind="video_export" initial={videoExport} />
      <InfraCostForm initial={infraCosts} />
      <AnonymousChatForm initial={anonymousChat} today={anonymousToday} />
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
  const [credits, setCredits] = useState(String(initial.credits));
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
          credits: Number(credits),
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
        {' · '}
        <strong>{formatNumber(price.credits, locale)} credits</strong>
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
        <label className="grid gap-2">
          {kind === 'plan' ? p.planCredits : p.packCredits}
          <input
            className="input"
            type="number"
            min="1"
            max="100000000"
            step="1"
            required
            value={credits}
            onChange={(e) => setCredits(e.target.value)}
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

const creditAmountKeys = { welcome: 'welcome', video_script: 'videoScript', video_export: 'videoExport' } as const;

function CreditAmountForm({ initial, kind }: { initial: CreditAmountView; kind: keyof typeof creditAmountKeys }) {
  const { t, locale } = useI18n();
  const p = t.pricingAdmin;
  const key = creditAmountKeys[kind];
  const labels = p[key];
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
        body: JSON.stringify({ kind, credits, revision: saved.revision }),
      });
      const result = (await response.json()) as Partial<Record<typeof key, CreditAmountView>> & { error?: keyof typeof p.errors };
      const updated = result[key];
      if (!response.ok || !updated) {
        setMessage((result.error && p.errors[result.error]) || t.common.errors.generic);
        return;
      }
      setSaved(updated);
      setMessage(labels.saved);
    } catch {
      setMessage(t.common.errors.network);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="card pricing-admin-card pricing-credit-card" onSubmit={save}>
      <div>
        <h2>{labels.title}</h2>
        <p className="muted">{labels.note}</p>
      </div>
      <p>
        {labels.current}: <strong>{formatNumber(saved.credits, locale)} credits</strong>
      </p>
      <fieldset disabled={busy}>
        <label>
          {labels.amount}
          <input
            className="input"
            type="number"
            required
            min={kind === 'welcome' ? 0 : 1}
            max="100000000"
            step="1"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        <button className="btn" type="submit">
          {busy ? p.saving : labels.save}
        </button>
      </fieldset>
      {message && <p role="status">{message}</p>}
    </form>
  );
}

const infraFields = [
  { key: 'transferPerGb', step: '0.000000000001', min: '0.000000000001' },
  { key: 'blobStoragePerGbMonth', step: '0.000000000001', min: '0.000000000001' },
  { key: 'databaseStoragePerGbMonth', step: '0.000000000001', min: '0.000000000001' },
  { key: 'databaseIndexFactor', step: '0.0001', min: '1' },
  { key: 'chunkRowBytes', step: '1', min: '1' },
] as const;

/** Our infrastructure rates: transfer, Blob and database storage (docs/audit/credit-import-audit.md P4). */
function InfraCostForm({ initial }: { initial: InfraCostRatesView }) {
  const { t, locale } = useI18n();
  const p = t.pricingAdmin;
  const labels = p.infraCosts;
  const [saved, setSaved] = useState(initial);
  const [values, setValues] = useState<Record<(typeof infraFields)[number]['key'], string>>({
    transferPerGb: initial.transferPerGb,
    blobStoragePerGbMonth: initial.blobStoragePerGbMonth,
    databaseStoragePerGbMonth: initial.databaseStoragePerGbMonth,
    databaseIndexFactor: initial.databaseIndexFactor,
    chunkRowBytes: String(initial.chunkRowBytes),
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch('/api/admin/pricing', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'infra_costs',
          revision: saved.revision,
          transferPerGb: values.transferPerGb.trim(),
          blobStoragePerGbMonth: values.blobStoragePerGbMonth.trim(),
          databaseStoragePerGbMonth: values.databaseStoragePerGbMonth.trim(),
          databaseIndexFactor: values.databaseIndexFactor.trim(),
          chunkRowBytes: /^\d+$/.test(values.chunkRowBytes.trim()) ? Number(values.chunkRowBytes.trim()) : null,
        }),
      });
      const result = (await response.json()) as { infraCosts?: InfraCostRatesView; error?: keyof typeof p.errors };
      if (!response.ok || !result.infraCosts) {
        setMessage((result.error && p.errors[result.error]) || t.common.errors.generic);
        return;
      }
      setSaved(result.infraCosts);
      setMessage(labels.saved);
    } catch {
      setMessage(t.common.errors.network);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="card pricing-admin-card pricing-credit-card" onSubmit={save}>
      <div>
        <h2>{labels.title}</h2>
        <p className="muted">{labels.note}</p>
      </div>
      <p>
        {labels.current}:{' '}
        <strong>
          {saved.effectiveFrom ? `${labels.since} ${new Date(saved.effectiveFrom).toLocaleString(locale, { timeZone: 'Asia/Shanghai' })} (UTC+8)` : labels.defaults}
        </strong>
      </p>
      <fieldset disabled={busy} className="grid gap-4">
        {infraFields.map((field) => (
          <label className="grid gap-2" key={field.key}>
            {labels.fields[field.key]}
            <input
              className="input"
              type="number"
              inputMode="decimal"
              required
              min={field.min}
              step={field.step}
              value={values[field.key]}
              onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}
            />
          </label>
        ))}
        <button className="btn" type="submit">
          {busy ? p.saving : labels.save}
        </button>
      </fieldset>
      {message && <p role="status">{message}</p>}
    </form>
  );
}

/** Anonymous chat's daily caps and attempts factor (lib/services/anonymous-chat-settings.ts). */
function AnonymousChatForm({ initial, today }: { initial: AnonymousChatLimits; today: number }) {
  const { t, locale } = useI18n();
  const p = t.pricingAdmin;
  const labels = p.anonymousChat;
  const [saved, setSaved] = useState(initial);
  const [values, setValues] = useState<Record<AnonymousLimitField, string>>(
    () => Object.fromEntries(ANONYMOUS_LIMIT_FIELDS.map((field) => [field, String(initial[field])])) as Record<AnonymousLimitField, string>,
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      const whole = (value: string) => (/^\d+$/.test(value.trim()) ? Number(value.trim()) : null);
      const response = await fetch('/api/admin/pricing', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'anonymous_chat',
          revision: saved.revision,
          ...Object.fromEntries(ANONYMOUS_LIMIT_FIELDS.map((field) => [field, whole(values[field])])),
        }),
      });
      const result = (await response.json()) as { anonymousChat?: AnonymousChatLimits; error?: keyof typeof p.errors };
      if (!response.ok || !result.anonymousChat) {
        setMessage((result.error && p.errors[result.error]) || t.common.errors.generic);
        return;
      }
      setSaved(result.anonymousChat);
      setMessage(labels.saved);
    } catch {
      setMessage(t.common.errors.network);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="card pricing-admin-card pricing-credit-card" onSubmit={save}>
      <div>
        <h2>{labels.title}</h2>
        <p className="muted">{labels.note}</p>
      </div>
      <p>
        <strong>{fill(labels.today, { n: formatNumber(today, locale), limit: formatNumber(saved.platformRoundsPerDay, locale) })}</strong>
        {saved.revision === 'default' && <span className="muted"> · {labels.defaults}</span>}
      </p>
      <fieldset disabled={busy} className="grid gap-4">
        {ANONYMOUS_LIMIT_FIELDS.map((field) => (
          <label className="grid gap-2" key={field}>
            {labels.fields[field]}
            <input
              className="input"
              type="number"
              inputMode="numeric"
              required
              min="1"
              max={ANONYMOUS_LIMIT_BOUNDS[field]}
              step="1"
              value={values[field]}
              onChange={(e) => setValues({ ...values, [field]: e.target.value })}
            />
          </label>
        ))}
        <button className="btn" type="submit">
          {busy ? p.saving : labels.save}
        </button>
      </fieldset>
      {message && <p role="status">{message}</p>}
    </form>
  );
}
