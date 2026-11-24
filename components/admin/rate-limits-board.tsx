'use client';

import { useState, type FormEvent } from 'react';
import type { CeilingRow, RateLimitExemptionRow, RateLimitName, RateLimitRow, RateRuleValue } from '@/lib/services/rate-limit-settings';
import { RATE_LIMIT_EXEMPT_DEFAULT, RATE_LIMIT_MODEL_COST } from '@/lib/constants';
import { api } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { fill, formatDateTime, formatNumber } from '@/i18n/format';
import { ConfirmModal } from '@/components/admin/console-modal';
import { PageHead, RecordsTable, Tag } from '@/components/admin/list-kit';
import { useToast } from '@/components/ui/toast';
import './rate-limits.css';

interface Board { limits: RateLimitRow[]; exemptions: RateLimitExemptionRow[]; ceilings: CeilingRow[] }
type Drafts = Record<string, { perMinute: string; perHour: string }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const whole = (value: string) => (/^\d+$/.test(value.trim()) ? Number(value.trim()) : null);
const draftsOf = (limits: RateLimitRow[]): Drafts => Object.fromEntries(limits.map((row) => [row.name, { perMinute: String(row.perMinute ?? ''), perHour: String(row.perHour ?? '') }]));
const ceilingDraftsOf = (ceilings: CeilingRow[]): Record<string, string> => Object.fromEntries(ceilings.map((row) => [row.key, String(row.value)]));
const scopesOf = (exemptions: RateLimitExemptionRow[]) => Object.fromEntries(exemptions.map((row) => [row.userId, row.limits]));
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((name) => b.includes(name));

/** The console's rate-limit page: each limit's two windows, the daily and per-minute ceilings, reset to default, and the exempt accounts with the limits each covers. */
export function RateLimitsBoard({ initial }: { initial: Board }) {
  const { t, locale } = useI18n();
  const m = t.rateLimits;
  const toast = useToast();
  const [data, setData] = useState(initial);
  const [drafts, setDrafts] = useState<Drafts>(() => draftsOf(initial.limits));
  const [ceilingDrafts, setCeilingDrafts] = useState(() => ceilingDraftsOf(initial.ceilings));
  const [scopes, setScopes] = useState<Record<string, RateLimitName[]>>(() => scopesOf(initial.exemptions));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [account, setAccount] = useState('');
  const [note, setNote] = useState('');
  const [covers, setCovers] = useState<RateLimitName[]>([...RATE_LIMIT_EXEMPT_DEFAULT]);
  const [removing, setRemoving] = useState<RateLimitExemptionRow | null>(null);
  const message = (code?: string) => m.errors[code as keyof typeof m.errors] ?? m.errors.failed;
  const n = (value: number) => formatNumber(value, locale);
  const names = data.limits.map((row) => row.name);
  const rule = (value: RateRuleValue) => (value.windowSeconds === 60 ? fill(m.minuteRule, { n: n(value.limit) }) : value.windowSeconds === 3_600 ? fill(m.hourRule, { n: n(value.limit) }) : fill(m.secondsRule, { n: n(value.limit), seconds: n(value.windowSeconds) }));

  const reload = async () => {
    const result = await api<Board>('/api/admin/rate-limits', { cache: 'no-store' });
    if (!result.ok) throw new Error('reload');
    setData(result.data);
    setDrafts(draftsOf(result.data.limits));
    setCeilingDrafts(ceilingDraftsOf(result.data.ceilings));
    setScopes(scopesOf(result.data.exemptions));
  };
  /* A change the server accepted is reported as done even if the list then fails to load. */
  const mutate = async (request: () => ReturnType<typeof api<{ error?: string }>>, done: string, after?: () => void) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await request();
      if (!result.ok) { setError(message(result.data.error)); return; }
      after?.();
      toast(done);
      try {
        await reload();
      } catch {
        setNotice(m.reloadFailed);
      }
    } catch {
      setError(m.errors.failed);
    } finally {
      setBusy(false);
    }
  };
  const save = (name: string) => {
    const draft = drafts[name]!;
    return mutate(() => api('/api/admin/rate-limits', { method: 'PUT', json: { name, perMinute: whole(draft.perMinute), perHour: whole(draft.perHour) } }), m.saved);
  };
  const reset = (name: string) => mutate(() => api('/api/admin/rate-limits', { method: 'DELETE', json: { name } }), m.resetDone);
  const saveCeiling = (key: string) => mutate(() => api('/api/admin/rate-limits/ceilings', { method: 'PUT', json: { key, value: whole(ceilingDrafts[key] ?? '') } }), m.saved);
  const resetCeiling = (key: string) => mutate(() => api('/api/admin/rate-limits/ceilings', { method: 'DELETE', json: { key } }), m.resetDone);
  const add = (event: FormEvent) => {
    event.preventDefault();
    const value = account.trim();
    void mutate(
      () => api('/api/admin/rate-limits/exemptions', { method: 'POST', json: { ...(UUID.test(value) ? { userId: value } : { email: value }), note, limits: covers } }),
      m.added,
      () => { setAccount(''); setNote(''); setCovers([...RATE_LIMIT_EXEMPT_DEFAULT]); },
    );
  };
  const saveScope = (row: RateLimitExemptionRow) => mutate(() => api('/api/admin/rate-limits/exemptions', { method: 'POST', json: { userId: row.userId, limits: scopes[row.userId] ?? row.limits } }), m.updated);
  const remove = () => removing && mutate(() => api(`/api/admin/rate-limits/exemptions/${removing.userId}`, { method: 'DELETE' }), m.removed, () => setRemoving(null));

  const toggle = (list: readonly RateLimitName[], name: RateLimitName, on: boolean) => (on ? names.filter((each) => each === name || list.includes(each)) : list.filter((each) => each !== name));
  const checkboxes = (id: string, value: readonly RateLimitName[], onChange: (next: RateLimitName[]) => void) => (
    <div className="rate-limit-covers" role="group" aria-label={m.covers}>
      {names.map((name) => (
        <label key={name} className="rate-limit-cover">
          <input type="checkbox" id={`${id}-${name}`} checked={value.includes(name)} disabled={busy} onChange={(e) => onChange(toggle(value, name, e.target.checked))} />
          <code>{name}</code>
          {(RATE_LIMIT_MODEL_COST as readonly string[]).includes(name) && <small className="muted">{m.modelCost}</small>}
        </label>
      ))}
    </div>
  );

  const limitRows = data.limits.map((row) => {
    const draft = drafts[row.name] ?? { perMinute: '', perHour: '' };
    const edit = (key: 'perMinute' | 'perHour', value: string) => setDrafts({ ...drafts, [row.name]: { ...draft, [key]: value } });
    const changed = draft.perMinute !== String(row.perMinute) || draft.perHour !== String(row.perHour);
    const name = (
      <div key="name" className="rate-limit-name">
        <strong>{m.names[row.name]}</strong>
        <code>{row.name}</code>
        <small className="muted">{fill(m.defaults, { rules: row.defaultRules.map(rule).join(' · ') })}</small>
      </div>
    );
    if (!row.editable) return [name, <small key="fixed" className="muted">{m.notEditable}</small>, '', '', ''];
    return [
      name,
      <input key="minute" className="input rate-limit-input" type="number" inputMode="numeric" min={1} max={1_000_000} step={1} aria-label={`${row.name} ${m.perMinute}`} value={draft.perMinute} disabled={busy} onChange={(e) => edit('perMinute', e.target.value)} />,
      <input key="hour" className="input rate-limit-input" type="number" inputMode="numeric" min={1} max={1_000_000} step={1} aria-label={`${row.name} ${m.perHour}`} value={draft.perHour} disabled={busy} onChange={(e) => edit('perHour', e.target.value)} />,
      <Tag key="state" tone={row.overridden ? 'orange' : 'grey'}>{row.overridden ? m.custom : m.default}</Tag>,
      <div key="actions" className="flex">
        <button type="button" className="btn sm" disabled={busy || !changed} onClick={() => void save(row.name)}>{m.save}</button>
        {row.overridden && <button type="button" className="btn secondary sm" disabled={busy} onClick={() => void reset(row.name)}>{m.reset}</button>}
      </div>,
    ];
  });

  const ceilingRows = data.ceilings.map((row) => {
    const draft = ceilingDrafts[row.key] ?? '';
    const ruleOf = (value: number) => fill(row.per === 'day' ? m.dayRule : m.minuteRule, { n: n(value) });
    return [
      <div key="name" className="rate-limit-name">
        <strong>{m.ceilings[row.key]}</strong>
        <code>{row.key}</code>
        <small className="muted">{fill(m.ceilingDefault, { rule: ruleOf(row.defaultValue) })}</small>
        <small className="muted">{row.exemptedBy ? fill(m.exemptedBy, { name: row.exemptedBy }) : m.notExemptable}</small>
      </div>,
      <div key="value" className="flex">
        <input className="input rate-limit-input" type="number" inputMode="numeric" min={1} max={100_000} step={1} aria-label={`${row.key} ${m.ceilingValue}`} value={draft} disabled={busy} onChange={(e) => setCeilingDrafts({ ...ceilingDrafts, [row.key]: e.target.value })} />
        <small className="muted">{row.per === 'day' ? m.dayUnit : m.minuteUnit}</small>
      </div>,
      <Tag key="state" tone={row.overridden ? 'orange' : 'grey'}>{row.overridden ? m.custom : m.default}</Tag>,
      <div key="actions" className="flex">
        <button type="button" className="btn sm" disabled={busy || draft === String(row.value)} onClick={() => void saveCeiling(row.key)}>{m.save}</button>
        {row.overridden && <button type="button" className="btn secondary sm" disabled={busy} onClick={() => void resetCeiling(row.key)}>{m.reset}</button>}
      </div>,
    ];
  });

  const exemptRows = data.exemptions.map((row) => {
    const scope = scopes[row.userId] ?? row.limits;
    return [
      <div key="account" className="rate-limit-name"><strong>{row.name}</strong><small className="muted">{row.email}</small><code>{row.userId}</code>{row.note && <small>{row.note}</small>}</div>,
      <div key="covers">
        {checkboxes(`scope-${row.userId}`, scope, (next) => setScopes({ ...scopes, [row.userId]: next }))}
        <button type="button" className="btn secondary sm" disabled={busy || scope.length === 0 || sameSet(scope, row.limits)} onClick={() => void saveScope(row)}>{m.saveCovers}</button>
      </div>,
      <span key="since">{formatDateTime(row.createdAt, locale)}</span>,
      <button key="remove" type="button" className="btn ghost sm" disabled={busy} onClick={() => { setError(''); setRemoving(row); }}>{m.remove}</button>,
    ];
  });

  return <>
    <PageHead title={m.title} lede={m.lede} />
    {error && !removing && <div className="form-error" role="alert">{error}</div>}
    {notice && <div className="form-error" role="status">{notice}</div>}
    <section className="card rate-limits-info"><p className="muted">{m.policy}</p></section>
    <section className="card record-table rate-limits-section">
      <h2>{m.limitsTitle}</h2>
      <RecordsTable label={m.limitsTitle} head={[m.limit, m.perMinute, m.perHour, '', '']} rows={limitRows} empty={m.errors.not_found} />
    </section>
    <section className="card record-table rate-limits-section">
      <h2>{m.ceilingsTitle}</h2>
      <p className="muted">{m.ceilingsLede}</p>
      <RecordsTable label={m.ceilingsTitle} head={[m.limit, m.ceilingValue, '', '']} rows={ceilingRows} empty={m.errors.not_found} />
    </section>
    <section className="card record-table rate-limits-section">
      <h2>{m.exemptTitle}</h2>
      <p className="muted">{m.exemptLede}</p>
      <form className="rate-limit-exempt-form" onSubmit={add}>
        <fieldset disabled={busy}>
          <div className="field"><label htmlFor="rate-limit-account">{m.email}</label><input id="rate-limit-account" required value={account} placeholder={m.emailHint} onChange={(e) => setAccount(e.target.value)} /></div>
          <div className="field"><label htmlFor="rate-limit-note">{m.note}</label><input id="rate-limit-note" maxLength={200} value={note} placeholder={m.noteHint} onChange={(e) => setNote(e.target.value)} /></div>
          <div className="field rate-limit-covers-field"><span className="field-label">{m.covers}</span>{checkboxes('new', covers, setCovers)}</div>
          <button className="btn" type="submit" disabled={covers.length === 0}>{m.add}</button>
        </fieldset>
      </form>
      <RecordsTable label={m.exemptTitle} head={[m.account, m.covers, m.since, '']} rows={exemptRows} empty={m.exemptEmpty} />
    </section>
    <ConfirmModal open={Boolean(removing)} title={fill(m.removeTitle, { name: removing?.name ?? '' })} body={<>{error && <div className="form-error" role="alert">{error}</div>}<p>{m.removeBody}</p></>} confirmLabel={m.remove} danger busy={busy} onClose={() => !busy && setRemoving(null)} onConfirm={() => void remove()} />
  </>;
}
