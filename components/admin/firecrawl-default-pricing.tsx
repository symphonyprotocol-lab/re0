'use client';
import { useEffect, useState } from 'react';
import type { ServicePricingInput } from '@/lib/domain/service-pricing';
import { api } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { ServiceCostFields } from '@/components/admin/service-cost-fields';

export function FirecrawlDefaultPricing({ initial, onSaved }: { initial: ServicePricingInput | null; onSaved: () => Promise<void> }) {
  const { t } = useI18n();
  const p = t.servicePricing;
  const [pricing, setPricing] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => setPricing(initial), [initial]);
  return <form className="card firecrawl-info firecrawl-pricing-form" onSubmit={async (event) => {
    event.preventDefault(); setBusy(true); setMessage('');
    try {
      const response = await api<{ error?: string }>('/api/admin/firecrawl/pricing', { method: 'PUT', json: { pricing } });
      if (!response.ok) { setMessage(response.data.error === 'cost_pricing' ? p.invalid : t.common.errors.generic); return; }
      await onSaved(); setMessage(p.saved);
    } catch { setMessage(t.common.errors.network); } finally { setBusy(false); }
  }}>
    <h2>{p.firecrawlDefault}</h2><p className="small muted">{p.firecrawlDefaultNote}</p>
    <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0 }}><ServiceCostFields service="firecrawl" value={pricing} onChange={setPricing} label={p.defaultEnabled} /><button type="submit" className="btn secondary">{busy ? t.pricingAdmin.saving : p.saveDefault}</button></fieldset>
    {message && <p role="status">{message}</p>}
  </form>;
}
