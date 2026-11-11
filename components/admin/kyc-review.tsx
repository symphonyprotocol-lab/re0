'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ADMIN_REASON } from '@/lib/constants';
import { api } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { fill } from '@/i18n/format';
import { CI } from '@/components/admin/console-icon';
import { useConfirmStep } from '@/components/admin/confirm-step';
import { useToast } from '@/components/ui/toast';
// console.css first, so these later prototype rules keep their cascade order.
import '@/components/admin/console.css';
import '@/components/admin/console-finance.css';

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
    <section className="kyc-comparison-section">
      <div className="between kyc-comparison-heading">
        <div>
          <h2>{d.compare}</h2>
          <p id="kyc-preview-notice" role="status">
            {notice}
          </p>
        </div>
        {available && view.phase !== 'deleted' && (
          <button type="button" className="btn secondary sm" onClick={() => void load()} disabled={view.phase === 'loading'}>
            <CI name="refresh" />
            {d.renew}
          </button>
        )}
      </div>
      <div className="kyc-comparison-grid">
        {(['document', 'selfie'] as const).map((slot) => {
          const file = view.phase === 'live' ? view.files[slot] : null;
          return (
            <article key={slot} className="card kyc-preview-panel">
              <div className="kyc-preview-title">
                <span>
                  <CI name={slot === 'document' ? 'file' : 'users'} />
                  {slot === 'document' ? d.document : d.selfie}
                </span>
                <small>{slot === 'document' ? d.documentHint : d.selfieHint}</small>
              </div>
              <div className="kyc-preview-stage" id={`kyc-preview-${slot}`}>
                {view.phase === 'loading' ? (
                  <p>{d.loading}</p>
                ) : file ? (
                  // eslint-disable-next-line @next/next/no-img-element -- a 60-second signed link, never optimised or cached
                  <img className="kyc-local-image" src={file.url} alt={slot === 'document' ? d.documentAlt : d.selfieAlt} referrerPolicy="no-referrer" />
                ) : (
                  <div className="kyc-preview-empty">
                    <CI name={view.phase === 'expired' ? 'clock' : 'shield'} />
                    <strong>{view.phase === 'expired' ? d.expiredTitle : view.phase === 'deleted' ? d.deletedTitle : view.phase === 'failed' ? d.loadFailed : d.noneTitle}</strong>
                    {view.phase !== 'failed' && <p>{view.phase === 'expired' ? d.expiredBody : view.phase === 'deleted' ? d.deletedBody : d.noneBody}</p>}
                  </div>
                )}
              </div>
              <p className="kyc-preview-caption">{d.caption}</p>
            </article>
          );
        })}
      </div>
    </section>
  );
}

/**
 * The newest pending submission's decision (prototype `#manual-kyc-review`):
 * "已比对" must be ticked to approve; rejecting needs a 3–300 character
 * note, which the user reads.
 */
export function KycDecision({ id, name }: { id: string; name: string }) {
  const { t } = useI18n();
  const d = t.consolePayouts.kycDetail;
  const c = t.consoleConfirm.kyc;
  const { ask, dialog } = useConfirmStep();
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
    setError('');
    const approve = decision === 'verified';
    ask({
      title: approve ? c.approveTitle : c.rejectTitle,
      body: fill(approve ? c.approveBody : c.rejectBody, { name }),
      label: approve ? c.approve : c.reject,
      danger: !approve,
      run: () => send(decision, reason),
    });
  }

  async function send(decision: 'verified' | 'rejected', reason: string) {
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
      id="manual-kyc-review"
      className="kyc-review-decision"
      onSubmit={(event) => {
        event.preventDefault();
        /* Only a click on one of the two buttons decides: a submit without one (Enter in a field) is not an approval. */
        const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
        if (submitter?.value === 'rejected' || submitter?.value === 'verified') void decide(submitter.value);
      }}
    >
      <label className="check-row small">
        <input type="checkbox" name="matched" checked={matched} onChange={(event) => setMatched(event.target.checked)} />
        {d.matched}
      </label>
      <div className="field mt16">
        <label htmlFor="kyc-reason">{d.note}</label>
        <textarea id="kyc-reason" name="reason" rows={2} maxLength={ADMIN_REASON.max} value={note} onChange={(event) => setNote(event.target.value)} />
      </div>
      <div className="flex">
        <button className="btn secondary" type="submit" name="decision" value="rejected" disabled={busy !== null}>
          {d.reject}
        </button>
        <button className="btn" type="submit" name="decision" value="verified" disabled={busy !== null}>
          {d.approve}
        </button>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {dialog}
    </form>
  );
}
