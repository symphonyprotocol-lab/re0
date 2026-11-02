'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ADMIN_REASON } from '@/lib/constants';
import { api } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { fill } from '@/i18n/format';
import { Icon, Spinner, type IconName } from '@/components/ui/icons';
import { useToast } from '@/components/ui/toast';

type Slot = 'document' | 'selfie';
type Files = Record<Slot, { url: string; expiresAt: string } | null>;
type View = { phase: 'loading' } | { phase: 'live'; files: Files; expiresAt: number } | { phase: 'expired' } | { phase: 'deleted' } | { phase: 'failed' };

/**
 * The two images side by side (prototype manual-kyc.js `refreshPreviews`):
 * signed links fetched on arrival and on "重新获取预览", each fetch audited
 * on the server, and both previews dropped when the 60 seconds are up, so a
 * page left open shows nothing until renewed.
 */
export function KycFiles({ id, available }: { id: string; available: boolean }) {
  const { t } = useI18n();
  const d = t.consolePayouts.kycDetail;
  const [view, setView] = useState<View>(available ? { phase: 'loading' } : { phase: 'deleted' });
  const [now, setNow] = useState(() => Date.now());
  const started = useRef(false);

  const load = useCallback(async () => {
    setView({ phase: 'loading' });
    const result = await api<{ deleted?: boolean; files?: Files; expiresAt?: string | null }>(`/api/admin/kyc/${id}/files`, { method: 'POST', json: {} });
    if (!result.ok || !result.data.files) return setView({ phase: 'failed' });
    if (result.data.deleted) return setView({ phase: 'deleted' });
    setNow(Date.now());
    setView({ phase: 'live', files: result.data.files, expiresAt: Date.parse(result.data.expiresAt ?? '') || Date.now() + 60_000 });
  }, [id]);

  useEffect(() => {
    if (!available || started.current) return;
    started.current = true;
    void load();
  }, [available, load]);

  useEffect(() => {
    if (view.phase !== 'live') return;
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= view.expiresAt) setView({ phase: 'expired' });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [view]);

  const seconds = view.phase === 'live' ? Math.max(0, Math.ceil((view.expiresAt - now) / 1000)) : 0;
  const notice = view.phase === 'live' ? fill(d.noticeLive, { s: seconds }) : view.phase === 'expired' ? d.noticeExpired : view.phase === 'deleted' ? d.noticeDeleted : d.notice;

  return (
    <section className="min-w-0">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[15px] font-bold">{d.compare}</h2>
          <p role="status" className="mt-1 text-[12px] text-muted">
            {notice}
          </p>
        </div>
        {available && view.phase !== 'deleted' && (
          <button type="button" className="btn-secondary btn-sm" onClick={() => void load()} disabled={view.phase === 'loading'}>
            {view.phase === 'loading' ? <Spinner /> : <Icon name="refresh" className="size-3.5" />}
            {d.renew}
          </button>
        )}
      </div>
      <div className="mt-3 grid min-w-0 gap-4 md:grid-cols-2">
        {(['document', 'selfie'] as const).map((slot) => {
          const file = view.phase === 'live' ? view.files[slot] : null;
          return (
            <article key={slot} className="card min-w-0 overflow-hidden">
              <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-3">
                <span className="flex items-center gap-2 text-[13px] font-bold">
                  <Icon name={slot === 'document' ? 'file' : 'users'} className="size-4 text-muted" />
                  {slot === 'document' ? d.document : d.selfie}
                </span>
                <small className="text-[11px] text-muted">{slot === 'document' ? d.documentHint : d.selfieHint}</small>
              </div>
              <div className="flex aspect-[4/3] min-w-0 items-center justify-center bg-[#f3f5fa]">
                {view.phase === 'loading' ? (
                  <span className="flex items-center gap-2 text-[12px] text-muted">
                    <Spinner />
                    {d.loading}
                  </span>
                ) : file ? (
                  // eslint-disable-next-line @next/next/no-img-element -- a 60-second signed link, never optimised or cached
                  <img src={file.url} alt={slot === 'document' ? d.document : d.selfie} referrerPolicy="no-referrer" className="size-full object-contain" />
                ) : (
                  <Placeholder
                    icon={view.phase === 'expired' ? 'clock' : 'shield'}
                    title={view.phase === 'expired' ? d.expiredTitle : view.phase === 'deleted' ? d.deletedTitle : view.phase === 'failed' ? d.loadFailed : d.noneTitle}
                    body={view.phase === 'expired' ? d.expiredBody : view.phase === 'deleted' ? d.deletedBody : view.phase === 'failed' ? '' : d.noneBody}
                  />
                )}
              </div>
              <p className="px-4 py-2 text-[11px] text-muted">{d.caption}</p>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function Placeholder({ icon, title, body }: { icon: IconName; title: string; body: string }) {
  return (
    <div className="flex max-w-[260px] flex-col items-center gap-1.5 px-4 text-center">
      <Icon name={icon} className="size-6 text-muted" />
      <strong className="text-[13px]">{title}</strong>
      {body && <p className="text-[11px] text-muted">{body}</p>}
    </div>
  );
}

/**
 * The newest pending submission's decision (prototype `#manual-kyc-review`):
 * "已比对" must be ticked to approve; rejecting needs a 3–300 character
 * note, which the user reads.
 */
export function KycDecision({ id }: { id: string }) {
  const { t } = useI18n();
  const d = t.consolePayouts.kycDetail;
  const errors = t.consolePayouts.errors as Record<string, string>;
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<'verified' | 'rejected' | null>(null);
  const [matched, setMatched] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  async function decide(decision: 'verified' | 'rejected') {
    const reason = note.trim();
    const length = Array.from(reason).length;
    if ((decision === 'rejected' || length > 0) && (length < ADMIN_REASON.min || length > ADMIN_REASON.max)) return setError(errors.reason!);
    if (decision === 'verified' && !matched) return setError(errors.matched!);
    setBusy(decision);
    setError('');
    const result = await api<{ error?: string }>(`/api/admin/kyc/${id}/${decision === 'verified' ? 'approve' : 'reject'}`, { method: 'POST', json: { matched, reason } });
    setBusy(null);
    if (!result.ok) {
      setError(errors[result.data.error ?? ''] ?? (t.console.errors as Record<string, string>)[result.data.error ?? ''] ?? t.console.errors.generic);
      return;
    }
    toast(decision === 'verified' ? d.approved : d.rejected);
    router.refresh();
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
        void decide(submitter?.value === 'rejected' ? 'rejected' : 'verified');
      }}
    >
      <label className="flex items-start gap-2.5 text-[13px] leading-relaxed">
        <input type="checkbox" name="matched" className="mt-1 size-4 flex-none accent-blue" checked={matched} onChange={(event) => setMatched(event.target.checked)} />
        {d.matched}
      </label>
      <label htmlFor="kyc-note" className="field-label mt-4">
        {d.note}
      </label>
      <textarea id="kyc-note" name="reason" rows={3} maxLength={ADMIN_REASON.max} value={note} onChange={(event) => setNote(event.target.value)} className="input resize-y" />
      <small className="hint block">{Array.from(note).length} / {ADMIN_REASON.max}</small>
      {error && (
        <p role="alert" className="mt-3 text-[12px] text-red">
          {error}
        </p>
      )}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button type="submit" name="decision" value="rejected" className="btn-secondary" disabled={busy !== null}>
          {busy === 'rejected' && <Spinner />}
          {d.reject}
        </button>
        <button type="submit" name="decision" value="verified" className="btn" disabled={busy !== null}>
          {busy === 'verified' ? <Spinner /> : <Icon name="check" className="size-4" />}
          {d.approve}
        </button>
      </div>
    </form>
  );
}
