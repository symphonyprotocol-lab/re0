'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AdminPublicQa } from '@/lib/services/public-qa';
import { useI18n } from '@/i18n/client';
import { formatDateTime } from '@/i18n/format';
import { RecordsTable } from '@/components/admin/list-kit';
import { useToast } from '@/components/ui/toast';

/**
 * The console's "公开问答" tab of a Ree: its public answers, reported ones
 * first, with why a hidden one is hidden. An administrator hides a
 * published answer or restores a hidden one (both in the management log).
 */
export function ReePublicQaTab({ reeId, rows }: { reeId: string; rows: AdminPublicQa[] }) {
  const { t, locale } = useI18n();
  const r = t.consoleRees.ree.qa;
  const toast = useToast();
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  async function set(row: AdminPublicQa, show: boolean) {
    setBusy(row.id);
    try {
      const response = await fetch(`/api/admin/rees/${reeId}/public-qa/${row.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ show }) });
      toast(response.ok ? (show ? r.restored : r.hiddenDone) : r.stale);
      router.refresh();
    } catch {
      toast(t.common.errors.generic);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card">
      <div className="admin-ree-section admin-ree-audit-head">
        <h2>{r.title}</h2>
        <p className="muted small">{r.lede}</p>
      </div>
      <RecordsTable
        actions
        label={r.title}
        empty={r.empty}
        head={[r.columns.time, r.columns.question, r.columns.answer, r.columns.status, r.columns.reports, '']}
        rows={rows.map((row) => [
          formatDateTime(row.createdAt, locale),
          <span key="q" className="block max-w-[260px] whitespace-normal">{row.question}</span>,
          <span key="a" className="block max-w-[360px] whitespace-normal text-muted">{row.answer}</span>,
          <span key="s">
            {r.status[row.status]}
            {row.hiddenBy && <span className="block text-[11px] text-muted">{r.hiddenBy[row.hiddenBy]}</span>}
          </span>,
          <span key="r" className="mono">{row.reports}</span>,
          row.status === 'published' ? (
            <button key="act" type="button" className="btn ghost sm" disabled={busy === row.id} onClick={() => void set(row, false)}>{r.hide}</button>
          ) : row.status === 'hidden' ? (
            <button key="act" type="button" className="btn ghost sm" disabled={busy === row.id} onClick={() => void set(row, true)}>{r.restore}</button>
          ) : (
            <span key="act" />
          ),
        ])}
      />
    </section>
  );
}
