'use client';

import { useState, type FormEvent } from 'react';
import type { RateLimitExemptionRow, RateLimitRow } from '@/lib/services/rate-limit-settings';
import { api } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { fill, formatDateTime, formatNumber } from '@/i18n/format';
import { ConfirmModal } from '@/components/admin/console-modal';
import { PageHead, RecordsTable, Tag } from '@/components/admin/list-kit';
import { useToast } from '@/components/ui/toast';
import './rate-limits.css';

interface Board { limits: RateLimitRow[]; exemptions: RateLimitExemptionRow[] }
type Drafts = Record<string, { perMinute: string; perHour: string }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const whole = (value: string) => (/^\d+$/.test(value.trim()) ? Number(value.trim()) : null);
const draftsOf = (limits: RateLimitRow[]): Drafts => Object.fromEntries(limits.map((row) => [row.name, { perMinute: String(row.perMinute), perHour: String(row.perHour) }]));

/** The console's rate-limit page: each limit's two windows, reset to default, and the exempt accounts. */
export function RateLimitsBoard({ initial }: { initial: Board }) {
  const { t, locale } = useI18n();
  const m = t.rateLimits;
  const toast = useToast();
  const [data, setData] = useState(initial);
  const [drafts, setDrafts] = useState<Drafts>(() => draftsOf(initial.limits));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [account, setAccount] = useState('');
  const [note, setNote] = useState('');
  const [removing, setRemoving] = useState<RateLimitExemptionRow | null>(null);
  const message = (code?: string) => m.errors[code as keyof typeof m.errors] ?? m.errors.failed;
  const n = (value: number) => formatNumber(value, locale);

  const reload = async () => {
    const result = await api<Board>('/api/admin/rate-limits', { cache: 'no-store' });
    if (!result.ok) throw new Error('reload');
    setData(result.data);
    setDrafts(draftsOf(result.data.limits));
  };
  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await operation();
    } catch {
      setError(m.errors.failed);
    } finally {
      setBusy(false);
    }
  };
  const save = (name: string) => run(async () => {
    const draft = drafts[name]!;
    const result = await api<{ error?: string }>('/api/admin/rate-limits', { method: 'PUT', json: { name, perMinute: whole(draft.perMinute), perHour: whole(draft.perHour) } });
    if (!result.ok) { setError(message(result.data.error)); return; }
    await reload();
    toast(m.saved);
  });
  const reset = (name: string) => run(async () => {
    const result = await api<{ error?: string }>('/api/admin/rate-limits', { method: 'DELETE', json: { name } });
    if (!result.ok) { setError(message(result.data.error)); return; }
    await reload();
    toast(m.resetDone);
  });
  const add = (event: FormEvent) => {
    event.preventDefault();
    const value = account.trim();
    void run(async () => {
      const result = await api<{ error?: string }>('/api/admin/rate-limits/exemptions', {
        method: 'POST',
        json: { ...(UUID.test(value) ? { userId: value } : { email: value }), note },
      });
      if (!result.ok) { setError(message(result.data.error)); return; }
      setAccount('');
      setNote('');
      await reload();
      toast(m.added);
    });
  };
  const remove = () => removing && run(async () => {
    const result = await api<{ error?: string }>(`/api/admin/rate-limits/exemptions/${removing.userId}`, { method: 'DELETE' });
    if (!result.ok) { setError(message(result.data.error)); return; }
    setRemoving(null);
    await reload();
    toast(m.removed);
  });

  const limitRows = data.limits.map((row) => {
    const draft = drafts[row.name] ?? { perMinute: '', perHour: '' };
    const edit = (key: 'perMinute' | 'perHour', value: string) => setDrafts({ ...drafts, [row.name]: { ...draft, [key]: value } });
    const changed = draft.perMinute !== String(row.perMinute) || draft.perHour !== String(row.perHour);
    return [
      <div key="name" className="rate-limit-name">
        <strong>{m.names[row.name]}</strong>
        <code>{row.name}</code>
        <small className="muted">{fill(m.defaults, { minute: n(row.defaults.perMinute), hour: n(row.defaults.perHour) })}</small>
      </div>,
      <input key="minute" className="input rate-limit-input" type="number" inputMode="numeric" min={1} max={1_000_000} step={1} aria-label={`${row.name} ${m.perMinute}`} value={draft.perMinute} disabled={busy} onChange={(e) => edit('perMinute', e.target.value)} />,
      <input key="hour" className="input rate-limit-input" type="number" inputMode="numeric" min={1} max={1_000_000} step={1} aria-label={`${row.name} ${m.perHour}`} value={draft.perHour} disabled={busy} onChange={(e) => edit('perHour', e.target.value)} />,
      <Tag key="state" tone={row.overridden ? 'orange' : 'grey'}>{row.overridden ? m.custom : m.default}</Tag>,
      <div key="actions" className="flex">
        <button type="button" className="btn sm" disabled={busy || !changed} onClick={() => void save(row.name)}>{m.save}</button>
        {row.overridden && <button type="button" className="btn secondary sm" disabled={busy} onClick={() => void reset(row.name)}>{m.reset}</button>}
      </div>,
    ];
  });

  const exemptRows = data.exemptions.map((row) => [
    <div key="account" className="rate-limit-name"><strong>{row.name}</strong><small className="muted">{row.email}</small><code>{row.userId}</code></div>,
    <span key="note">{row.note ?? '—'}</span>,
    <span key="since">{formatDateTime(row.createdAt, locale)}</span>,
    <button key="remove" type="button" className="btn ghost sm" disabled={busy} onClick={() => { setError(''); setRemoving(row); }}>{m.remove}</button>,
  ]);

  return <>
    <PageHead title={m.title} lede={m.lede} />
    {error && !removing && <div className="form-error" role="alert">{error}</div>}
    <section className="card rate-limits-info"><p className="muted">{m.policy}</p></section>
    <section className="card record-table rate-limits-section">
      <h2>{m.limitsTitle}</h2>
      <RecordsTable label={m.limitsTitle} head={[m.limit, m.perMinute, m.perHour, '', '']} rows={limitRows} empty={m.errors.not_found} />
    </section>
    <section className="card record-table rate-limits-section">
      <h2>{m.exemptTitle}</h2>
      <p className="muted">{m.exemptLede}</p>
      <form className="rate-limit-exempt-form" onSubmit={add}>
        <fieldset disabled={busy}>
          <div className="field"><label htmlFor="rate-limit-account">{m.email}</label><input id="rate-limit-account" required value={account} placeholder={m.emailHint} onChange={(e) => setAccount(e.target.value)} /></div>
          <div className="field"><label htmlFor="rate-limit-note">{m.note}</label><input id="rate-limit-note" maxLength={200} value={note} placeholder={m.noteHint} onChange={(e) => setNote(e.target.value)} /></div>
          <button className="btn" type="submit">{m.add}</button>
        </fieldset>
      </form>
      <RecordsTable label={m.exemptTitle} head={[m.account, m.note, m.since, '']} rows={exemptRows} empty={m.exemptEmpty} />
    </section>
    <ConfirmModal open={Boolean(removing)} title={fill(m.removeTitle, { name: removing?.name ?? '' })} body={<>{error && <div className="form-error" role="alert">{error}</div>}<p>{m.removeBody}</p></>} confirmLabel={m.remove} danger busy={busy} onClose={() => !busy && setRemoving(null)} onConfirm={() => void remove()} />
  </>;
}
