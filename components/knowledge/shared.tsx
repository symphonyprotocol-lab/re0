'use client';

import type { ReactNode } from 'react';
import type { KnowledgeActivity } from '@/lib/domain/knowledge';
import type { Messages } from '@/i18n';
import { fill, formatNumber } from '@/i18n/format';
import { failureLabel } from '@/components/knowledge/status-badge';

export { KIND_ICONS } from '@/components/knowledge/kind-icons';

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
      <mark key={hit} data-match="" className="rounded bg-[#fff1b8] px-0.5 text-ink [&.current]:bg-[#ffd666]">
        {text.slice(hit, hit + needle.length)}
      </mark>,
    );
    at = hit + needle.length;
    hits += 1;
  }
  parts.push(text.slice(at));
  return parts;
}

/** The on/off switch of "参与回答". */
export function Switch({ checked, label, disabled, onChange }: { checked: boolean; label: string; disabled?: boolean; onChange: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className={`relative inline-flex h-5 w-9 flex-none items-center rounded-full transition disabled:opacity-40 ${checked ? 'bg-blue' : 'bg-[#cfd5e3]'}`}
    >
      <span className={`inline-block size-4 rounded-full bg-white shadow transition ${checked ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
    </button>
  );
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
    case 'parsed':
      return fill(k.parsed, { chars: n(d.chars), pages: d.pages ? fill(k.parsedPages, { pages: n(d.pages) }) : '' });
    case 'failed':
      return fill(k.failed, { reason: failureLabel(t, String(d.reason ?? '')) });
    case 'fetched': {
      const what = d.files !== undefined ? fill(k.fetchedFiles, { files: n(d.files), revision: String(d.revision ?? '') }) : d.pages !== undefined ? fill(k.fetchedPages, { pages: n(d.pages) }) : '';
      return fill(k.fetched, { what: `${what}${d.truncated ? k.fetchedTruncated : ''}` });
    }
    case 'moved':
      return fill(k.moved, { folder: String(d.folder || t.knowledge.folders.unfiled) });
    default:
      return fill(k[entry.code], Object.fromEntries(Object.entries(d).map(([key, value]) => [key, typeof value === 'number' ? n(value) : value])));
  }
}
