'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ROLE_REASON_MAX } from '@/lib/constants';
import { api } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { Icon, Spinner } from '@/components/ui/icons';
import { useToast } from '@/components/ui/toast';

/**
 * The pending request's decision (prototype role-pages.js `reviewPage`): one
 * note, required to reject and optional to approve, then 拒绝申请 or 批准认证.
 */
export function VerificationDecision({ id }: { id: string }) {
  const { t } = useI18n();
  const v = t.consoleUsers.verifications.detail;
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<'approved' | 'rejected' | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  async function decide(decision: 'approved' | 'rejected') {
    const reason = note.trim();
    const length = Array.from(reason).length;
    if ((decision === 'rejected' && length < 1) || length > ROLE_REASON_MAX) {
      setError(decision === 'rejected' ? v.rejectNeedsReason : v.errors.reason);
      return;
    }
    setBusy(decision);
    setError('');
    const result = await api<{ error?: string }>(`/api/admin/verifications/${id}/${decision === 'approved' ? 'approve' : 'reject'}`, {
      method: 'POST',
      json: { reason },
    });
    setBusy(null);
    if (!result.ok) {
      const code = result.data.error ?? '';
      setError((v.errors as Record<string, string>)[code] ?? (t.console.errors as Record<string, string>)[code] ?? t.console.errors.generic);
      return;
    }
    toast(decision === 'approved' ? v.approved : v.rejected);
    router.refresh();
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
        void decide(submitter?.value === 'rejected' ? 'rejected' : 'approved');
      }}
    >
      <label htmlFor="verification-note" className="field-label">
        {v.note}
      </label>
      <textarea
        id="verification-note"
        name="reason"
        rows={4}
        maxLength={ROLE_REASON_MAX}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        className="input resize-y"
      />
      <small className="hint block">
        {v.noteHint} · {Array.from(note).length} / {ROLE_REASON_MAX}
      </small>
      {error && (
        <p role="alert" className="mt-3 text-[12px] text-red">
          {error}
        </p>
      )}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button type="submit" name="decision" value="rejected" className="btn-secondary" disabled={busy !== null}>
          {busy === 'rejected' && <Spinner />}
          {v.reject}
        </button>
        <button type="submit" name="decision" value="approved" className="btn" disabled={busy !== null}>
          {busy === 'approved' ? <Spinner /> : <Icon name="check" className="size-4" />}
          {v.approve}
        </button>
      </div>
    </form>
  );
}
