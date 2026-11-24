'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AdminCompetition } from '@/lib/services/competitions';
import { useI18n } from '@/i18n/client';
import { formatDateTime } from '@/i18n/format';
import { RecordsTable } from '@/components/admin/list-kit';
import { useToast } from '@/components/ui/toast';

/** The console's competitions (competitions.ts `adminCompetitions`): cancel one before its results, or hide / restore a published one's. */
export function AdminCompetitionsTable({ rows }: { rows: AdminCompetition[] }) {
  const { t, locale } = useI18n();
  const a = t.competitions.admin;
  const toast = useToast();
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  async function act(row: AdminCompetition, action: 'cancel' | 'hide' | 'restore') {
    const reason = action === 'cancel' ? window.prompt(a.cancelPrompt) : '';
    if (reason === null) return;
    setBusy(row.id);
    try {
      const response = await fetch(`/api/admin/competitions/${row.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, reason }) });
      toast(response.ok ? a.done : a.stale);
      router.refresh();
    } catch {
      toast(t.common.errors.generic);
    } finally {
      setBusy(null);
    }
  }

  const live = (row: AdminCompetition) => !['published', 'cancelled', 'rejected'].includes(row.status);
  return (
    <RecordsTable
      actions
      label={a.title}
      empty={a.empty}
      head={[a.columns.created, a.columns.title, a.columns.status, a.columns.entries, a.columns.reports, a.columns.changes, a.columns.actions]}
      rows={rows.map((row) => [
        formatDateTime(row.createdAt, locale),
        <a key="t" href={`/admin/competitions/${row.id}`} className="block max-w-[360px] whitespace-normal hover:underline">
          {row.title}
          <span className="block text-[11px] text-muted">#{row.slug}</span>
        </a>,
        <span key="s">
          {t.competitions.status[row.status]}
          {row.hidden && <span className="block text-[11px] text-muted">{a.hide}</span>}
        </span>,
        <span key="e" className="mono">{row.entries} / {row.maxEntries}</span>,
        <span key="r" className="mono">{row.reports}</span>,
        <span key="c" className="mono">{row.bigChanges}</span>,
        <span key="act" className="flex flex-wrap gap-1">
          <a href={`/admin/competitions/${row.id}`} className="btn ghost sm">
            {a.open}
          </a>
          {live(row) && (
            <button type="button" className="btn ghost sm" disabled={busy === row.id} onClick={() => void act(row, 'cancel')}>
              {a.cancel}
            </button>
          )}
          {row.status === 'published' && (
            <button type="button" className="btn ghost sm" disabled={busy === row.id} onClick={() => void act(row, row.hidden ? 'restore' : 'hide')}>
              {row.hidden ? a.restore : a.hide}
            </button>
          )}
        </span>,
      ])}
    />
  );
}
