'use client';

/**
 * Publishing a file's original (docs/design/agent-workspace-p4.md §2.6) on
 * the web: the dialog (checks listed before anything goes out), the actions
 * on a published file, the public page's report form, and the console's
 * takedown, restore and freeze buttons.
 */
import { useEffect, useState } from 'react';
import { useNavigationRouter as useRouter } from '@/components/shell/navigation-provider';
import { api } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { fill } from '@/i18n/format';
import { Icon } from '@/components/ui/icons';
import { ConfirmModal, Modal } from '@/components/ui/modal';
import { useToast } from '@/components/ui/toast';

interface Check {
  key: string;
  ok: boolean;
  detail?: string;
}

interface CheckResult {
  path: string;
  file_name: string;
  size: number;
  media_type: string;
  checks: Check[];
  ok: boolean;
}

const mb = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

/** One check as a line: what passed, or what was found and what to do. */
export function CheckLine({ check }: { check: Check }) {
  const { t } = useI18n();
  const c = t.publish.checks;
  let text: string;
  switch (check.key) {
    case 'type':
      text = check.ok ? fill(c.type.ok, { ext: (check.detail ?? '').toUpperCase() }) : `${c.type.bad}. ${c.type.badDetail}`;
      break;
    case 'size':
      text = fill(check.ok ? c.size.ok : c.size.bad, { cap: mb(Number(check.detail) || 0) });
      break;
    case 'account':
      text = check.ok ? c.account.ok : c.account[(check.detail ?? 'disabled') as keyof typeof c.account] ?? c.account.disabled;
      break;
    case 'count':
      text = fill(check.ok ? c.count.ok : c.count.bad, { n: check.detail ?? '' });
      break;
    case 'blocked':
      text = check.ok ? c.blocked.ok : c.blocked.bad;
      break;
    case 'active_content':
      text = check.ok ? c.active_content.ok : c.active_content[(check.detail ?? 'too_large_to_check') as keyof typeof c.active_content] ?? c.active_content.too_large_to_check;
      break;
    case 'image':
      text = check.ok ? c.image.ok : fill(c.image.bad, { type: check.detail ?? '' });
      break;
    case 'secrets':
      text = check.ok ? (check.detail === 'no_text' ? c.secrets.no_text : c.secrets.ok) : fill(c.secrets.bad, { kind: check.detail ?? '' });
      break;
    default:
      text = check.ok ? c.text.ok : c.text.bad;
  }
  return (
    <li className={check.ok ? 'is-ok' : 'is-bad'}>
      <Icon name={check.ok ? 'check' : 'alert'} />
      <span>{text}</span>
    </li>
  );
}

function errorOf(t: ReturnType<typeof useI18n>['t'], code: string | undefined): string {
  const e = t.publish.errors;
  return code && code in e ? e[code as keyof typeof e] : e.generic;
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** "公开原文" on a file page: checks the current version, then publishes it with a title. */
export function PublishButton({ path, revision, freeMb, dailyMb }: { path: string; revision: string | null; freeMb: number; dailyMb: number }) {
  const { t } = useI18n();
  const d = t.publish.dialog;
  const toast = useToast();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [title, setTitle] = useState('');
  const [indexable, setIndexable] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setResult(null);
    const query = new URLSearchParams({ path, ...(revision ? { revision } : {}) });
    void api<CheckResult & { error?: string }>(`/api/files/publish?${query.toString()}`).then((response) => {
      if (!live) return;
      if (!response.ok) {
        setOpen(false);
        toast(errorOf(t, response.data.error));
        return;
      }
      setResult(response.data);
      setTitle((current) => current || response.data.file_name);
    });
    return () => {
      live = false;
    };
  }, [open, path, revision, t, toast]);

  const publish = async () => {
    setBusy(true);
    const response = await api<{ url?: string; error?: string; checks?: Check[] }>('/api/files/publish', { method: 'POST', json: { path, revision, title, indexable } });
    setBusy(false);
    if (!response.ok) {
      if (response.data.checks && result) setResult({ ...result, checks: response.data.checks, ok: false });
      return toast(errorOf(t, response.data.error));
    }
    setOpen(false);
    if (response.data.url) await copy(response.data.url);
    toast(d.done);
    router.refresh();
  };

  return (
    <>
      <button type="button" className="btn sm" onClick={() => setOpen(true)}>
        <Icon name="globe" />
        {t.publish.button}
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={result && !result.ok ? d.blockedTitle : d.title}
        subtitle={d.lede}
        wide
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>
              {result && !result.ok ? d.close : d.cancel}
            </button>
            {result?.ok && (
              <button type="button" className="btn" disabled={busy || !title.trim()} onClick={() => void publish()}>
                <Icon name="globe" />
                {d.publish}
              </button>
            )}
          </>
        }
      >
        <div className="ws-form publish-form">
          <span className="field-label">{d.file}</span>
          <div className="ws-picked">
            <Icon name="file" />
            <span className="mono">{result?.path ?? path}</span>
            {result && <small>{mb(result.size) === '0 MB' ? `${Math.max(1, Math.round(result.size / 1024))} KB` : mb(result.size)}</small>}
          </div>
          {result?.ok && (
            <>
              <label className="field-label mt-4" htmlFor="publish-title">
                {d.titleLabel}
              </label>
              <input id="publish-title" className="input" value={title} maxLength={80} onChange={(event) => setTitle(event.target.value)} />
            </>
          )}
          <span className="field-label mt-4">{d.checks}</span>
          {result ? (
            <ul className="publish-checks">
              {result.checks.map((check) => (
                <CheckLine key={`${check.key}-${check.detail ?? ''}`} check={check} />
              ))}
            </ul>
          ) : (
            <p className="ws-muted">{d.checking}</p>
          )}
          {result?.ok && (
            <>
              <label className="publish-check-row">
                <span>
                  <strong>{d.indexable}</strong>
                  <small>{d.indexableHint}</small>
                </span>
                <input type="checkbox" checked={indexable} onChange={(event) => setIndexable(event.target.checked)} />
              </label>
              <p className="ws-fine">
                <Icon name="lock" />
                {fill(d.fine, { free: mb(freeMb * 1024 * 1024), daily: mb(dailyMb * 1024 * 1024) })}
              </p>
            </>
          )}
        </div>
      </Modal>
    </>
  );
}

/** Copy, update to the current version, stop: the actions on a published file (the file page's card, the usage list). */
export function PublicationActions({ id, url, title, stale, compact = false }: { id: string; url: string; title: string; stale: boolean; compact?: boolean }) {
  const { t } = useI18n();
  const c = t.publish.card;
  const toast = useToast();
  const router = useRouter();
  const [stopping, setStopping] = useState(false);
  const [busy, setBusy] = useState(false);
  const update = async () => {
    setBusy(true);
    const response = await api<{ error?: string; checks?: Check[] }>(`/api/files/publish/${id}`, { method: 'PATCH', json: { to_current: true } });
    setBusy(false);
    if (!response.ok) return toast(errorOf(t, response.data.error));
    toast(c.updated);
    router.refresh();
  };
  return (
    <div className="publish-actions">
      {!compact && (
        <button type="button" className="btn secondary sm" onClick={() => void copy(url).then((ok) => ok && toast(c.copy))}>
          <Icon name="copy" />
          {c.copy}
        </button>
      )}
      {stale && (
        <button type="button" className="btn secondary sm" disabled={busy} onClick={() => void update()}>
          <Icon name="refresh" />
          {c.update}
        </button>
      )}
      {!compact && (
        <a className="btn secondary sm" href={url} target="_blank" rel="noreferrer">
          <Icon name="external" />
          {c.open}
        </a>
      )}
      <button type="button" className="btn ghost sm publish-danger" onClick={() => setStopping(true)}>
        {c.stop}
      </button>
      <ConfirmModal
        open={stopping}
        title={c.stop}
        body={fill(c.stopConfirm, { title })}
        confirmLabel={c.stop}
        danger
        busy={busy}
        onClose={() => setStopping(false)}
        onConfirm={async () => {
          setBusy(true);
          const response = await api<{ error?: string }>(`/api/files/publish/${id}`, { method: 'DELETE' });
          setBusy(false);
          setStopping(false);
          if (!response.ok) return toast(errorOf(t, response.data.error));
          toast(c.stopped);
          router.refresh();
        }}
      />
    </div>
  );
}

/** The public page's copy-link button. */
export function CopyLink({ url }: { url: string }) {
  const { t } = useI18n();
  const toast = useToast();
  return (
    <button type="button" className="btn-secondary" onClick={() => void copy(url).then((ok) => ok && toast(t.publish.card.copy))}>
      <Icon name="copy" />
      {t.publish.page.copy}
    </button>
  );
}

/** The public page's report form: no sign-in, a reason and an optional note. */
export function ReportForm({ publicId }: { publicId: string }) {
  const { t } = useI18n();
  const r = t.publish.report;
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [state, setState] = useState<'idle' | 'busy' | 'sent'>('idle');
  const [error, setError] = useState('');
  const send = async () => {
    setState('busy');
    setError('');
    const response = await api<{ error?: string }>(`/api/public-files/${publicId}/report`, { method: 'POST', json: { reason, note } });
    if (!response.ok) {
      setState('idle');
      const code = response.data.error as keyof typeof r.errors | undefined;
      return setError(code && code in r.errors ? r.errors[code] : r.errors.generic);
    }
    setState('sent');
  };
  return (
    <>
      <button type="button" className="text-link publish-report-link" onClick={() => setOpen(true)}>
        <Icon name="flag" />
        {t.publish.page.report}
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={r.title}
        footer={
          state === 'sent' ? (
            <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>
              {t.publish.dialog.close}
            </button>
          ) : (
            <>
              <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>
                {r.cancel}
              </button>
              <button type="button" className="btn" disabled={!reason || state === 'busy'} onClick={() => void send()}>
                {r.send}
              </button>
            </>
          )
        }
      >
        {state === 'sent' ? (
          <p role="status">{r.sent}</p>
        ) : (
          <div className="ws-form">
            <span className="field-label">{r.reason}</span>
            <div className="publish-reasons" role="radiogroup" aria-label={r.reason}>
              {(Object.keys(r.reasons) as (keyof typeof r.reasons)[]).map((key) => (
                <label key={key} className={reason === key ? 'is-on' : undefined}>
                  <input type="radio" name="report-reason" value={key} checked={reason === key} onChange={() => setReason(key)} />
                  {r.reasons[key]}
                </label>
              ))}
            </div>
            <label className="field-label mt-4" htmlFor="report-note">
              {r.note}
            </label>
            <textarea id="report-note" className="input" rows={3} maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} />
            {error && (
              <p role="alert" className="form-error">
                {error}
              </p>
            )}
          </div>
        )}
      </Modal>
    </>
  );
}

/** The console's buttons on one public file: take down (with a reason), restore a suspended one, freeze or unfreeze its owner's publishing. */
export function AdminPublicationActions({ id, title, ownerId, suspended, revoked, frozen }: { id: string; title: string; ownerId: string; suspended: boolean; revoked: boolean; frozen: boolean }) {
  const { t } = useI18n();
  const a = t.publish.admin;
  const toast = useToast();
  const router = useRouter();
  const [taking, setTaking] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const post = async (url: string, json: Record<string, unknown>) => {
    setBusy(true);
    const response = await api<{ error?: string }>(url, { method: 'POST', json });
    setBusy(false);
    toast(response.ok ? a.done : a.stale);
    router.refresh();
    return response.ok;
  };
  return (
    <div className="flex flex-wrap gap-2">
      {!revoked && (
        <button type="button" className="btn ghost sm publish-danger" disabled={busy} onClick={() => setTaking(true)}>
          {a.takedown}
        </button>
      )}
      {!revoked && suspended && (
        <button type="button" className="btn secondary sm" disabled={busy} onClick={() => void post(`/api/admin/publications/${id}`, { action: 'restore' })}>
          {a.restore}
        </button>
      )}
      <button type="button" className="btn ghost sm" disabled={busy} onClick={() => void post('/api/admin/publications/freeze', { user_id: ownerId, frozen: !frozen })}>
        {frozen ? a.unfreeze : a.freeze}
      </button>
      <Modal
        open={taking}
        onClose={() => setTaking(false)}
        title={fill(a.takedownTitle, { title })}
        subtitle={a.takedownBody}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setTaking(false)}>
              {t.publish.dialog.cancel}
            </button>
            <button
              type="button"
              className="btn-danger"
              disabled={busy}
              onClick={() => void post(`/api/admin/publications/${id}`, { action: 'takedown', note }).then((ok) => ok && setTaking(false))}
            >
              {a.takedown}
            </button>
          </>
        }
      >
        <label className="field-label" htmlFor={`takedown-${id}`}>
          {a.note}
        </label>
        <textarea id={`takedown-${id}`} className="input" rows={3} maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} />
      </Modal>
    </div>
  );
}
