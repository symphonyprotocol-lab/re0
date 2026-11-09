'use client';
import { useId } from 'react';
import type { ServicePricingInput } from '@/lib/domain/service-pricing';
import { useI18n } from '@/i18n/client';
import { fill } from '@/i18n/format';
import './service-cost-fields.css';

export function emptyServicePricing(service: 'embedding' | 'transcription' | 'firecrawl'): ServicePricingInput {
  return { unit: service === 'embedding' ? 'million_tokens' : service === 'transcription' ? 'seconds' : 'firecrawl_credits', price: '', minimumUnits: 0, incrementUnits: 0, source: '' };
}
/** Embedded inside the service's own form; the same submit saves credentials and price. */
export function ServiceCostFields({ service, value, onChange, defaultValue, label, note }: {
  service: 'embedding' | 'transcription' | 'firecrawl'; value: ServicePricingInput | null;
  onChange: (value: ServicePricingInput | null) => void; defaultValue?: ServicePricingInput | null; label?: string; note?: string;
}) {
  const { t } = useI18n();
  const id = useId();
  const p = t.servicePricing;
  const patch = (next: Partial<ServicePricingInput>) => value && onChange({ ...value, ...next });
  return <fieldset className="service-cost-fields">
    <legend>{p.title}</legend>
    <label className="service-cost-toggle"><input type="checkbox" checked={value !== null} onChange={(event) => onChange(event.target.checked ? (defaultValue ?? emptyServicePricing(service)) : null)} />{label ?? p.override}</label>
    {note && <p className="small muted">{note}</p>}
    {value && <>
      {service === 'transcription' && <div className="field"><label htmlFor={`${id}-unit`}>{p.unit}</label><select id={`${id}-unit`} value={value.unit} onChange={(event) => patch({ unit: event.target.value as ServicePricingInput['unit'], price: '', outputPrice: undefined, audioPrice: undefined })}><option value="seconds">{p.units.seconds}</option><option value="million_tokens">{p.units.million_tokens}</option></select></div>}
      <div className="field"><label htmlFor={`${id}-price`}>{fill(p.price, { unit: p.units[value.unit] })}</label><input id={`${id}-price`} type="number" required min="0" max="99999999.999999999999" step={value.unit === 'million_tokens' ? '0.000001' : '0.000000000001'} value={value.price} onChange={(event) => patch({ price: event.target.value })} /></div>
      {service === 'transcription' && value.unit === 'million_tokens' && <>
        <div className="field"><label htmlFor={`${id}-output`}>{p.outputPrice}</label><input id={`${id}-output`} type="number" min="0" step="0.000001" value={value.outputPrice ?? ''} onChange={(event) => patch({ outputPrice: event.target.value || undefined })} /></div>
        <div className="field"><label htmlFor={`${id}-audio`}>{p.audioPrice}</label><input id={`${id}-audio`} type="number" min="0" step="0.000001" value={value.audioPrice ?? ''} onChange={(event) => patch({ audioPrice: event.target.value || undefined })} /></div>
      </>}
      <details><summary>{p.advanced}</summary>
        <div className="field"><label htmlFor={`${id}-minimum`}>{p.minimum}</label><input id={`${id}-minimum`} type="number" min="0" max="1000000" step="any" value={value.minimumUnits} onChange={(event) => patch({ minimumUnits: Number(event.target.value) })} /></div>
        <div className="field"><label htmlFor={`${id}-increment`}>{p.increment}</label><input id={`${id}-increment`} type="number" min="0" max="1000000" step="any" value={value.incrementUnits} onChange={(event) => patch({ incrementUnits: Number(event.target.value) })} />{value.unit === 'million_tokens' && <small>{p.quantityNote}</small>}</div>
        <div className="field"><label htmlFor={`${id}-source`}>{p.source}</label><input id={`${id}-source`} maxLength={500} value={value.source} onChange={(event) => patch({ source: event.target.value })} /></div>
      </details>
    </>}
  </fieldset>;
}
