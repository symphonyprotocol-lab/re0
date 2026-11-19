'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AdminPost } from '@/lib/services/posts';
import { useI18n } from '@/i18n/client';
import { formatDateTime } from '@/i18n/format';
import { RecordsTable } from '@/components/admin/list-kit';
import { useToast } from '@/components/ui/toast';

/** The console's public posts (posts.ts `adminPosts`): take a post down, or restore one an administrator or reports took down. */
export function AdminPostsTable({ rows }: { rows: AdminPost[] }) {
  const { t, locale } = useI18n();
  const a = t.posts.admin;
  const toast = useToast();
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  async function set(row: AdminPost, show: boolean) {
    setBusy(row.id);
    try {
      const response = await fetch(`/api/admin/posts/${row.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ show }) });
      toast(response.ok ? (show ? a.restored : a.hiddenDone) : a.stale);
      router.refresh();
    } catch {
      toast(t.common.errors.generic);
    } finally {
      setBusy(null);
    }
  }

  return (
    <RecordsTable
      actions
      label={a.title}
      empty={a.empty}
      head={[a.columns.time, a.columns.question, a.columns.status, a.columns.reports, a.columns.answers, a.columns.action]}
      rows={rows.map((row) => [
        formatDateTime(row.createdAt, locale),
        <a key="q" href={`/p/${row.id}`} target="_blank" rel="noreferrer" className="block max-w-[420px] whitespace-normal hover:underline">{row.question}</a>,
        <span key="s">
          {a.status[row.status]}
          {row.hiddenBy && <span className="block text-[11px] text-muted">{a.hiddenBy[row.hiddenBy]}</span>}
        </span>,
        <span key="r" className="mono">{row.reports}</span>,
        <span key="n" className="mono">{row.answers}</span>,
        <button key="act" type="button" className="btn ghost sm" disabled={busy === row.id} onClick={() => void set(row, row.status === 'hidden')}>
          {row.status === 'hidden' ? a.restore : a.hide}
        </button>,
      ])}
    />
  );
}
