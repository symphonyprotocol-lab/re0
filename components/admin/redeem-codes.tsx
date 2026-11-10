'use client';

import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber } from '@/i18n/format';
import { CI } from '@/components/admin/console-icon';
import { ConfirmModal, Modal } from '@/components/admin/console-modal';
import { useToast } from '@/components/ui/toast';
import './redeem-codes.css';

/* The form's times are UTC+8 wall clock, whatever the browser's zone (as on 价格与促销). */
const localTime = (iso: string) => new Date(Date.parse(iso) + 8 * 3600_000).toISOString().slice(0, 16);
const utcTime = (value: string) => (value ? new Date(`${value}:00+08:00`).toISOString() : '');

type Errors = Record<string, string>;

function useErrorText() {
  const { t } = useI18n();
  const errors = t.redeemAdmin.errors as Errors;
  return (code?: string) => (code && errors[code]) || errors.generic!;
}

interface Draft {
  name: string;
  note: string;
  kind: 'plan' | 'pack';
  months: string;
  quantity: string;
  mode: 'single' | 'multi';
  count: string;
  uses: string;
  unlimited: boolean;
  customCode: string;
  prefix: string;
  perCode: string;
  perUser: string;
  startsAt: string;
  expiresAt: string;
  noExpiry: boolean;
}

function freshDraft(): Draft {
  return {
    name: '',
    note: '',
    kind: 'pack',
    months: '1',
    quantity: '1',
    mode: 'single',
    count: '100',
    uses: '100',
    unlimited: false,
    customCode: '',
    prefix: '',
    perCode: '1',
    perUser: '1',
    startsAt: '',
    expiresAt: localTime(new Date(Date.now() + 90 * 86_400_000).toISOString()),
    noExpiry: false,
  };
}

function payload(draft: Draft) {
  const multi = draft.mode === 'multi';
  return {
    name: draft.name,
    note: draft.note,
    kind: draft.kind,
    planMonths: draft.kind === 'plan' ? draft.months : undefined,
    packQuantity: draft.kind === 'pack' ? draft.quantity : undefined,
    codeCount: multi ? 1 : draft.count,
    maxRedemptions: multi ? (draft.unlimited ? null : draft.uses) : draft.perCode,
    perUserLimit: draft.perUser,
    prefix: multi && draft.customCode.trim() ? '' : draft.prefix,
    customCode: multi ? draft.customCode : '',
    startsAt: draft.startsAt ? utcTime(draft.startsAt) : undefined,
    expiresAt: draft.noExpiry ? null : utcTime(draft.expiresAt),
  };
}

function downloadCsv(name: string, codes: string[]) {
  const quote = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  const blob = new Blob([`﻿${['code', ...codes].map(quote).join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `re0-redeem-codes-${name.replace(/[^\w-]+/g, '-').slice(0, 40) || 'batch'}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function Field({ id, label, hint, children }: { id: string; label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && <small>{hint}</small>}
    </div>
  );
}

/** `生成兑换码`: the new-batch form, then the codes it made, to download or copy. */
export function CreateBatchButton({ planCredits, packCredits }: { planCredits: number; packCredits: number }) {
  const { t, locale } = useI18n();
  const r = t.redeemAdmin;
  const f = r.form;
  const router = useRouter();
  const errorText = useErrorText();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(freshDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ id: string; name: string; codes: string[] } | null>(null);
  const [copied, setCopied] = useState(false);
  const set = (change: Partial<Draft>) => setDraft((current) => ({ ...current, ...change }));
  const n = (value: number) => formatNumber(value, locale);

  const close = () => {
    if (busy) return;
    setOpen(false);
    if (result) {
      setResult(null);
      router.refresh();
    }
  };
  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const response = await api<{ batch?: { id: string; name: string }; codes?: string[]; error?: string }>('/api/admin/redeem-batches', { method: 'POST', json: payload(draft) });
      if (!response.ok || !response.data.batch) {
        setError(errorText(response.data.error));
        return;
      }
      setResult({ id: response.data.batch.id, name: response.data.batch.name, codes: response.data.codes ?? [] });
      setDraft(freshDraft());
    } catch {
      setError(errorText());
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    if (!result) return;
    await navigator.clipboard.writeText(result.codes.join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 2_000);
  };

  return (
    <>
      <button type="button" className="btn" onClick={() => { setError(''); setOpen(true); }}>
        <CI name="plus" />
        {r.create}
      </button>
      <Modal
        open={open}
        onClose={close}
        wide
        title={result ? fill(r.result.title, { n: n(result.codes.length) }) : f.title}
        subtitle={result ? r.result.body : f.subtitle}
        footer={
          result ? (
            <>
              <button type="button" className="btn secondary" onClick={() => void copy()}>
                {copied ? r.result.copied : r.result.copy}
              </button>
              <button type="button" className="btn secondary" onClick={() => downloadCsv(result.name, result.codes)}>
                {r.result.download}
              </button>
              <Link className="btn" href={`/admin/redeem-codes/${result.id}`} onClick={() => { setOpen(false); setResult(null); }}>
                {r.result.view}
              </Link>
            </>
          ) : (
            <>
              <button type="button" className="btn secondary" disabled={busy} onClick={close}>
                {t.common.actions.cancel}
              </button>
              <button type="submit" form="redeem-batch-form" className="btn" disabled={busy}>
                {busy ? f.submitting : f.submit}
              </button>
            </>
          )
        }
      >
        {result ? (
          <textarea className="redeem-result" readOnly rows={Math.min(12, result.codes.length + 1)} value={result.codes.join('\n')} aria-label={r.detail.tabs.codes} />
        ) : (
          <form
            id="redeem-batch-form"
            className="redeem-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            {error && <div className="form-error" role="alert">{error}</div>}
            <Field id="redeem-name" label={f.name} hint={f.nameHint}>
              <input id="redeem-name" required maxLength={80} value={draft.name} onChange={(event) => set({ name: event.target.value })} />
            </Field>
            <fieldset className="redeem-choice">
              <legend>{f.kind}</legend>
              {(['plan', 'pack'] as const).map((kind) => (
                <label key={kind}>
                  <input type="radio" name="redeem-kind" checked={draft.kind === kind} onChange={() => set({ kind })} />
                  {r.kinds[kind]}
                </label>
              ))}
            </fieldset>
            {draft.kind === 'plan' ? (
              <Field id="redeem-months" label={f.months} hint={fill(f.creditsPlan, { credits: n(planCredits), months: draft.months || '—' })}>
                <input id="redeem-months" type="number" min={1} max={12} required value={draft.months} onChange={(event) => set({ months: event.target.value })} />
              </Field>
            ) : (
              <Field id="redeem-quantity" label={f.quantity} hint={fill(f.creditsPack, { credits: n(packCredits * (Number(draft.quantity) || 0)) })}>
                <input id="redeem-quantity" type="number" min={1} max={10} required value={draft.quantity} onChange={(event) => set({ quantity: event.target.value })} />
              </Field>
            )}
            <fieldset className="redeem-choice">
              <legend>{f.mode}</legend>
              <label>
                <input type="radio" name="redeem-mode" checked={draft.mode === 'single'} onChange={() => set({ mode: 'single' })} />
                <span>
                  {f.modeSingle}
                  <small>{f.modeSingleHint}</small>
                </span>
              </label>
              <label>
                <input type="radio" name="redeem-mode" checked={draft.mode === 'multi'} onChange={() => set({ mode: 'multi' })} />
                <span>
                  {f.modeMulti}
                  <small>{f.modeMultiHint}</small>
                </span>
              </label>
            </fieldset>
            {draft.mode === 'single' ? (
              <Field id="redeem-count" label={f.count}>
                <input id="redeem-count" type="number" min={1} max={10000} required value={draft.count} onChange={(event) => set({ count: event.target.value })} />
              </Field>
            ) : (
              <>
                <Field id="redeem-uses" label={f.uses}>
                  <div className="redeem-inline">
                    <input id="redeem-uses" type="number" min={1} required={!draft.unlimited} disabled={draft.unlimited} value={draft.uses} onChange={(event) => set({ uses: event.target.value })} />
                    <label className="redeem-check">
                      <input type="checkbox" checked={draft.unlimited} onChange={(event) => set({ unlimited: event.target.checked })} />
                      {f.unlimited}
                    </label>
                  </div>
                </Field>
                <Field id="redeem-custom" label={f.customCode} hint={f.customHint}>
                  <input id="redeem-custom" maxLength={40} autoComplete="off" value={draft.customCode} onChange={(event) => set({ customCode: event.target.value.toUpperCase() })} />
                </Field>
              </>
            )}
            <div className="redeem-row">
              <Field id="redeem-starts" label={f.startsAt} hint={f.startsHint}>
                <input id="redeem-starts" type="datetime-local" value={draft.startsAt} onChange={(event) => set({ startsAt: event.target.value })} />
              </Field>
              <Field id="redeem-expires" label={f.expiresAt}>
                <input id="redeem-expires" type="datetime-local" required={!draft.noExpiry} disabled={draft.noExpiry} value={draft.expiresAt} onChange={(event) => set({ expiresAt: event.target.value })} />
                <label className="redeem-check">
                  <input type="checkbox" checked={draft.noExpiry} onChange={(event) => set({ noExpiry: event.target.checked })} />
                  {f.noExpiry}
                </label>
              </Field>
            </div>
            <details className="redeem-advanced">
              <summary>{f.advanced}</summary>
              {!(draft.mode === 'multi' && draft.customCode.trim()) && (
                <Field id="redeem-prefix" label={f.prefix} hint={f.prefixHint}>
                  <input id="redeem-prefix" maxLength={8} autoComplete="off" value={draft.prefix} onChange={(event) => set({ prefix: event.target.value.toUpperCase() })} />
                </Field>
              )}
              <div className="redeem-row">
                {draft.mode === 'single' && (
                  <Field id="redeem-per-code" label={f.perCode}>
                    <input id="redeem-per-code" type="number" min={1} required value={draft.perCode} onChange={(event) => set({ perCode: event.target.value })} />
                  </Field>
                )}
                <Field id="redeem-per-user" label={f.perUser}>
                  <input id="redeem-per-user" type="number" min={1} max={1000} required value={draft.perUser} onChange={(event) => set({ perUser: event.target.value })} />
                </Field>
              </div>
              <Field id="redeem-note" label={f.note} hint={f.noteHint}>
                <textarea id="redeem-note" maxLength={500} rows={2} value={draft.note} onChange={(event) => set({ note: event.target.value })} />
              </Field>
            </details>
          </form>
        )}
      </Modal>
    </>
  );
}

/** A batch page's buttons: edit name / note / expiry, and disable or enable the whole batch. */
export function BatchActions({ batch }: { batch: { id: string; name: string; note: string | null; status: 'active' | 'disabled'; expiresAt: string | null } }) {
  const { t } = useI18n();
  const d = t.redeemAdmin.detail;
  const f = t.redeemAdmin.form;
  const router = useRouter();
  const toast = useToast();
  const errorText = useErrorText();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [name, setName] = useState(batch.name);
  const [note, setNote] = useState(batch.note ?? '');
  const [expiresAt, setExpiresAt] = useState(batch.expiresAt ? localTime(batch.expiresAt) : '');
  const [noExpiry, setNoExpiry] = useState(!batch.expiresAt);

  const patch = async (json: Record<string, unknown>, after: () => void) => {
    setBusy(true);
    setError('');
    try {
      const response = await api<{ error?: string }>(`/api/admin/redeem-batches/${batch.id}`, { method: 'PATCH', json });
      if (!response.ok) {
        setError(errorText(response.data.error));
        return;
      }
      after();
      toast(d.saved);
      router.refresh();
    } catch {
      setError(errorText());
    } finally {
      setBusy(false);
    }
  };
  const save = () => {
    const changes: Record<string, unknown> = { name, note };
    const original = batch.expiresAt ? localTime(batch.expiresAt) : '';
    if (noExpiry ? batch.expiresAt !== null : expiresAt !== original) changes.expiresAt = noExpiry ? null : utcTime(expiresAt);
    void patch(changes, () => setEditing(false));
  };
  const toggle = () => void patch({ status: batch.status === 'active' ? 'disabled' : 'active' }, () => setConfirming(false));

  return (
    <div className="flex">
      {error && !editing && !confirming && <span className="form-error" role="alert">{error}</span>}
      <button type="button" className="btn secondary" disabled={busy} onClick={() => { setError(''); setEditing(true); }}>
        {d.edit}
      </button>
      <button
        type="button"
        className={`btn ${batch.status === 'active' ? 'danger' : ''}`}
        disabled={busy}
        onClick={() => {
          setError('');
          if (batch.status === 'active') setConfirming(true);
          else toggle();
        }}
      >
        {batch.status === 'active' ? d.disable : d.enable}
      </button>
      <Modal
        open={editing}
        onClose={() => !busy && setEditing(false)}
        title={d.editTitle}
        subtitle={d.editHint}
        footer={
          <>
            <button type="button" className="btn secondary" disabled={busy} onClick={() => setEditing(false)}>
              {t.common.actions.cancel}
            </button>
            <button type="submit" form="redeem-edit-form" className="btn" disabled={busy}>
              {d.save}
            </button>
          </>
        }
      >
        <form
          id="redeem-edit-form"
          className="redeem-form"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          {error && <div className="form-error" role="alert">{error}</div>}
          <Field id="redeem-edit-name" label={f.name}>
            <input id="redeem-edit-name" required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field id="redeem-edit-note" label={f.note}>
            <textarea id="redeem-edit-note" maxLength={500} rows={2} value={note} onChange={(event) => setNote(event.target.value)} />
          </Field>
          <Field id="redeem-edit-expires" label={f.expiresAt}>
            <input id="redeem-edit-expires" type="datetime-local" required={!noExpiry} disabled={noExpiry} value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} />
            <label className="redeem-check">
              <input type="checkbox" checked={noExpiry} onChange={(event) => setNoExpiry(event.target.checked)} />
              {f.noExpiry}
            </label>
          </Field>
        </form>
      </Modal>
      <ConfirmModal
        open={confirming}
        title={d.disableTitle}
        body={
          <>
            {error && <div className="form-error" role="alert">{error}</div>}
            <p>{d.disableBody}</p>
          </>
        }
        confirmLabel={d.disable}
        danger
        busy={busy}
        onClose={() => !busy && setConfirming(false)}
        onConfirm={toggle}
      />
    </div>
  );
}

/** `····7KQ2` until "显示", which fetches the plaintext (and is audited). */
export function RevealCode({ id, last4 }: { id: string; last4: string }) {
  const { t } = useI18n();
  const d = t.redeemAdmin.detail;
  const errorText = useErrorText();
  const toast = useToast();
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reveal = async () => {
    setBusy(true);
    try {
      const response = await api<{ code?: string; error?: string }>(`/api/admin/redeem-codes/${id}/reveal`, { method: 'POST' });
      if (response.ok && response.data.code) setCode(response.data.code);
      else toast(errorText(response.data.error));
    } catch {
      toast(errorText());
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="redeem-code-cell">
      <span className="mono">{code ?? `····${last4}`}</span>
      <button type="button" className="text-link" disabled={busy} title={code ? undefined : d.revealHint} onClick={() => (code ? setCode(null) : void reveal())}>
        {code ? d.hide : d.reveal}
      </button>
    </span>
  );
}

/** One code off or back on. */
export function CodeToggle({ id, status }: { id: string; status: 'active' | 'disabled' }) {
  const { t } = useI18n();
  const d = t.redeemAdmin.detail;
  const router = useRouter();
  const toast = useToast();
  const errorText = useErrorText();
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    setBusy(true);
    try {
      const response = await api<{ error?: string }>(`/api/admin/redeem-codes/${id}`, { method: 'PATCH', json: { status: status === 'active' ? 'disabled' : 'active' } });
      if (!response.ok) toast(errorText(response.data.error));
      else router.refresh();
    } catch {
      toast(errorText());
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" className="btn secondary sm" disabled={busy} onClick={() => void toggle()}>
      {status === 'active' ? d.disableCode : d.enableCode}
    </button>
  );
}
