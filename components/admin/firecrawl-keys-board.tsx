'use client';

import { useEffect, useState } from 'react';
import type { FirecrawlKeyView } from '@/lib/services/firecrawl-keys';
import type { ServicePricingInput } from '@/lib/domain/service-pricing';
import { ServiceCostFields } from '@/components/admin/service-cost-fields';
import { FirecrawlDefaultPricing } from '@/components/admin/firecrawl-default-pricing';
import { api } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { fill, formatDateTime, formatNumber } from '@/i18n/format';
import { CI } from '@/components/admin/console-icon';
import { ConfirmModal, Modal } from '@/components/admin/console-modal';
import { PageHead, Stats, Tag } from '@/components/admin/list-kit';
import { useToast } from '@/components/ui/toast';
import './firecrawl-keys.css';

type KeyItem = Omit<FirecrawlKeyView, 'lastUsedAt' | 'cooldownUntil' | 'createdAt' | 'updatedAt'> & {
  lastUsedAt: string | null; cooldownUntil: string | null; createdAt: string; updatedAt: string;
};
interface Board { keys: KeyItem[]; baseUrl: string; environmentConfigured: boolean; defaultPricing: ServicePricingInput | null }
interface Draft { id: string | null; name: string; apiKey: string; enabled: boolean; isFallback: boolean; tail: string | null; costPricing: ServicePricingInput | null }

export function FirecrawlKeysBoard({ initial }: { initial: Board }) {
  const { t, locale } = useI18n();
  const m = t.firecrawl;
  const toast = useToast();
  const [data, setData] = useState(initial);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [removing, setRemoving] = useState<KeyItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  const cooling = (key: KeyItem) => Boolean(key.cooldownUntil && new Date(key.cooldownUntil).getTime() > now);
  const message = (code?: string) => code === 'cost_pricing' ? t.servicePricing.invalid : m.errors[code as keyof typeof m.errors] ?? m.errors.failed;
  const reload = async () => {
    const result = await api<Board>('/api/admin/firecrawl/keys', { cache: 'no-store' });
    if (!result.ok) throw new Error('reload');
    setData(result.data); setNow(Date.now());
  };
  const run = async (operation: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await operation(); } catch { setError(m.errors.failed); } finally { setBusy(false); }
  };
  const open = (key?: KeyItem) => {
    setError('');
    setDraft(key ? { id: key.id, name: key.name, apiKey: '', enabled: key.enabled, isFallback: key.isFallback, tail: key.apiKeyTail, costPricing: key.costPricing }
      : { id: null, name: '', apiKey: '', enabled: true, isFallback: false, tail: null, costPricing: null });
  };
  const save = () => draft && run(async () => {
    const result = await api<{ key: KeyItem; error?: string }>(`/api/admin/firecrawl/keys${draft.id ? `/${draft.id}` : ''}`, {
      method: draft.id ? 'PUT' : 'POST', json: { name: draft.name, apiKey: draft.apiKey, enabled: draft.enabled, isFallback: draft.isFallback, costPricing: draft.costPricing },
    });
    if (!result.ok) { setError(message(result.data.error)); return; }
    setDraft(null); toast(m.saved); await reload();
  });
  const toggle = (key: KeyItem) => run(async () => {
    const result = await api<{ error?: string }>(`/api/admin/firecrawl/keys/${key.id}`, { method: 'PUT', json: { name: key.name, apiKey: '', enabled: !key.enabled } });
    if (!result.ok) { setError(message(result.data.error)); return; }
    await reload(); toast(m.saved);
  });
  const remove = () => removing && run(async () => {
    const result = await api<{ error?: string }>(`/api/admin/firecrawl/keys/${removing.id}`, { method: 'DELETE' });
    if (!result.ok) { setError(message(result.data.error)); return; }
    setRemoving(null); await reload(); toast(m.deleted);
  });
  const date = (value: string | null) => value ? formatDateTime(value, locale) : m.never;

  return <>
    <PageHead title={m.title} lede={m.lede} actions={<div className="flex">
      <button type="button" className="btn secondary" disabled={busy} onClick={() => void run(reload)}>{m.refresh}</button>
      <button type="button" className="btn" disabled={busy} onClick={() => open()}><CI name="plus" />{m.add}</button>
    </div>} />
    {error && !draft && <div className="form-error" role="alert">{error}</div>}
    <div className="firecrawl-stats"><Stats items={[
      { label: m.total, value: formatNumber(data.keys.length, locale), icon: 'lock' },
      { label: m.available, value: formatNumber(data.keys.filter((key) => key.enabled && !cooling(key)).length, locale), icon: 'check' },
      { label: m.uses, value: formatNumber(data.keys.reduce((sum, key) => sum + key.useCount, 0), locale), icon: 'layers' },
    ]} /></div>
    <section className="card firecrawl-info">
      <p>{m.policy}</p><p>{m.storage}</p><p>{m.fallback}</p>
      <p className="muted">{m.endpoint} · <code>{data.baseUrl}</code> · {data.environmentConfigured ? m.environmentReady : m.environmentMissing}</p>
    </section>
    <FirecrawlDefaultPricing initial={data.defaultPricing} onSaved={reload} />
    <div className="firecrawl-key-grid">
      {data.keys.length === 0 && <div className="card firecrawl-info muted">{m.empty}</div>}
      {data.keys.map((key) => <article className="card firecrawl-key-card" key={key.id}>
        <div className="between"><strong>{key.name}</strong><Tag tone={!key.enabled ? 'grey' : cooling(key) ? 'orange' : 'green'}>{!key.enabled ? m.disabled : cooling(key) ? m.cooling : key.isFallback ? m.standby : m.enabled}</Tag></div>
        <p className="small muted">{key.isFallback ? m.mainAccount : m.rotatingAccount}</p>
        <p className="mono"><CI name="lock" /> •••• {key.apiKeyTail}</p>
        <p className="service-cost-summary">{t.servicePricing.title} · {key.costPricing ? fill(t.servicePricing.summary, { price: key.costPricing.price, unit: t.servicePricing.units.firecrawl_credits }) : `${t.servicePricing.inherit} · ${data.defaultPricing ? fill(t.servicePricing.summary, { price: data.defaultPricing.price, unit: t.servicePricing.units.firecrawl_credits }) : t.servicePricing.unknown}`}</p>
        <dl>
          <div><dt>{m.uses}</dt><dd>{formatNumber(key.useCount, locale)}</dd></div>
          <div><dt>{m.lastUsed}</dt><dd>{date(key.lastUsedAt)}</dd></div>
          <div><dt>{m.lastStatus}</dt><dd>{key.lastStatus === null ? m.never : key.lastStatus === 0 ? m.requestFailed : `HTTP ${key.lastStatus}`}</dd></div>
        </dl>
        {key.enabled && cooling(key) && <p className="small muted">{fill(m.cooldown, { time: date(key.cooldownUntil) })}</p>}
        <div className="flex">
          <button type="button" className="btn secondary sm" disabled={busy} onClick={() => open(key)}>{m.edit}</button>
          <button type="button" className="btn secondary sm" disabled={busy} onClick={() => void toggle(key)}>{key.enabled ? m.disable : m.enable}</button>
          <button type="button" className="btn ghost sm" disabled={busy} onClick={() => { setError(''); setRemoving(key); }}>{m.remove}</button>
        </div>
      </article>)}
    </div>
    <Modal open={Boolean(draft)} onClose={() => !busy && setDraft(null)} title={draft?.id ? m.editTitle : m.createTitle} subtitle={m.storage}
      footer={<><button type="button" className="btn secondary" disabled={busy} onClick={() => setDraft(null)}>{t.common.actions.cancel}</button><button type="submit" form="firecrawl-key-form" className="btn" disabled={busy}>{m.save}</button></>}>
      {draft && <form id="firecrawl-key-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="field"><label htmlFor="firecrawl-name">{m.name}</label><input id="firecrawl-name" required maxLength={80} value={draft.name} placeholder={m.nameHint} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></div>
        <div className="field"><label htmlFor="firecrawl-key">{m.key}</label><input id="firecrawl-key" type="password" autoComplete="new-password" required={!draft.id} minLength={8} maxLength={512} value={draft.apiKey} placeholder={draft.tail ? fill(m.keepKey, { tail: draft.tail }) : 'fc-…'} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} /></div>
        <label className="firecrawl-checkbox"><input type="checkbox" checked={draft.isFallback} onChange={(event) => setDraft({ ...draft, isFallback: event.target.checked })} />{m.fallbackField}</label>
        <p className="small muted">{m.fallbackHint}</p>
        <ServiceCostFields service="firecrawl" value={draft.costPricing} defaultValue={data.defaultPricing} onChange={(costPricing) => setDraft({ ...draft, costPricing })} note={t.servicePricing.firecrawlKeyNote} />
        <label className="firecrawl-checkbox"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />{m.enabledField}</label>
      </form>}
    </Modal>
    <ConfirmModal open={Boolean(removing)} title={fill(m.deleteTitle, { name: removing?.name ?? '' })} body={<>{error && <div className="form-error" role="alert">{error}</div>}<p>{m.deleteBody}</p></>} confirmLabel={m.remove} danger busy={busy} onClose={() => !busy && setRemoving(null)} onConfirm={() => void remove()} />
  </>;
}
