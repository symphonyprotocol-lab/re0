'use client';

import type { ReactNode } from 'react';
import type { KnowledgeActivity } from '@/lib/domain/knowledge';
import type { Messages } from '@/i18n';
import { fill, formatNumber } from '@/i18n/format';
import { failureLabel } from '@/components/knowledge/status-badge';
import type { ProviderCharge } from '@/lib/domain/provider-cost';

export { KIND_ICONS, SOURCE_ICONS } from '@/components/knowledge/kind-icons';


/** `m:ss`, or `h:mm:ss` past an hour. */
export function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = String(whole % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** `text` with every occurrence of `query` marked, case-insensitively (prototype `mark`). */
export function highlight(text: string, query: string): ReactNode {
  if (!query) return text;
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  const parts: ReactNode[] = [];
  let at = 0;
  let hits = 0;
  for (let hit = lower.indexOf(needle); hit !== -1 && hits < 1000; hit = lower.indexOf(needle, at)) {
    parts.push(
      text.slice(at, hit),
      <mark key={hit} data-match="">
        {text.slice(hit, hit + needle.length)}
      </mark>,
    );
    at = hit + needle.length;
    hits += 1;
  }
  parts.push(text.slice(at));
  return parts;
}

/** The on/off switch of "参与回答" (prototype `.switch`; the knob is its ::before). */
export function Switch({ checked, label, disabled, onChange }: { checked: boolean; label: string; disabled?: boolean; onChange: () => void }) {
  return <button type="button" className="switch" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={onChange} />;
}

export function errorText(t: Messages, code: string | undefined): string {
  const errors = t.knowledge.errors;
  return code && code in errors ? errors[code as keyof typeof errors] : t.common.errors.generic;
}

/** One line of the processing record, in words. */
export function activityLabel(t: Messages, locale: 'zh' | 'en', entry: KnowledgeActivity): string {
  const k = t.knowledge.activity;
  const d = entry.detail ?? {};
  const n = (value: unknown) => formatNumber(Number(value ?? 0), locale);
  switch (entry.code) {
    case 'transcribed':
      return d.seconds !== undefined ? fill(k.transcribedSeconds, { seconds: n(d.seconds) }) : fill(k.transcribed, { minutes: n(d.minutes) });
    case 'provider_usage': {
      try {
        const charge = JSON.parse(String(d.charge)) as ProviderCharge;
        const service = charge.service === 'transcription' ? k.transcriptionService : charge.service === 'embedding' ? 'Embedding' : 'Firecrawl';
        const units = [charge.usage.firecrawlCredits !== undefined ? `${n(charge.usage.firecrawlCredits)} Firecrawl credits` : '', charge.usage.inputTokens !== undefined ? `${n(charge.usage.inputTokens)} input tokens` : '', charge.usage.outputTokens !== undefined ? `${n(charge.usage.outputTokens)} output tokens` : '', charge.usage.seconds !== undefined ? fill(k.seconds, { seconds: n(charge.usage.seconds) }) : ''].filter(Boolean).join(', ');
        return fill(k.providerUsage, { service, model: charge.model, usage: units, cost: charge.costUsd === null ? k.costUnresolved : `$${charge.costUsd.replace(/0+$/, '').replace(/\.$/, '')}` }) + (d.reconciled ? ` · ${k.reconciledUsage}` : d.late ? ` · ${k.lateUsage}` : '');
      } catch { return k.costUnresolved; }
    }
    case 'settled': {
      const values = Object.fromEntries(Object.entries(d).map(([key, value]) => [key, typeof value === 'number' ? n(value) : value]));
      if (typeof values.costUsd === 'string') values.costUsd = values.costUsd.replace(/0+$/, '').replace(/\.$/, '');
      /* A failure the balance could not cover is owed (review C9): say so rather than "settled, released". */
      const label = fill(Number(d.owed ?? 0) > 0 ? k.settledOwed : k.settled, values);
      if (d.tariff === 'provider-cost-v1') return `${label} · ${fill(k.providerTotal, values)}`;
      return d.tariff ? `${label} · ${fill(k.usage, values)}` : label;
    }
    case 'chunked':
      return fill(k.chunked, { chunks: n(d.chunks) }) + (d.reused !== undefined ? fill(k.chunkedReused, { reused: n(d.reused) }) : '');
    case 'parsed':
      return fill(k.parsed, { chars: n(d.chars), pages: d.pages ? fill(k.parsedPages, { pages: n(d.pages) }) : '' });
    case 'failed':
      return fill(k.failed, { reason: failureLabel(t, String(d.reason ?? '')) });
    case 'fetched': {
      const what = d.files !== undefined ? fill(k.fetchedFiles, { files: n(d.files), revision: String(d.revision ?? '') }) : d.pages !== undefined ? fill(k.fetchedPages, { pages: n(d.pages) }) : '';
      const unread = d.unread !== undefined ? fill(k.fetchedUnread, { unread: n(d.unread) }) : '';
      return fill(k.fetched, { what: `${what}${d.truncated ? k.fetchedTruncated : ''}${unread}` });
    }
    case 'moved':
      return fill(k.moved, { folder: String(d.folder || t.knowledge.folders.unfiled) });
    default:
      return fill(k[entry.code], Object.fromEntries(Object.entries(d).map(([key, value]) => [key, typeof value === 'number' ? n(value) : value])));
  }
}
