'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ROLE_REASON_MAX } from '@/lib/constants';
import { api } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { CI } from '@/components/admin/console-icon';
import { useToast } from '@/components/ui/toast';

/**
 * The verification queue's page (prototype role-pages.js `list` /
 * `afterRender`): `.role-admin-list`, with the table's
 * `--record-table-height` sized so it scrolls inside the window with its
 * pages still in view.
 */
export function VerificationList({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const resize = () => {
      const wrap = root.querySelector<HTMLElement>('.table-wrap');
      const pager = root.querySelector<HTMLElement>('.role-list-pager');
      if (!wrap || !pager) return;
      const top = wrap.getBoundingClientRect().top + window.scrollY;
      root.style.setProperty('--record-table-height', `${Math.max(190, Math.min(800, window.innerHeight - top - pager.offsetHeight - 24))}px`);
    };
    const observer = new ResizeObserver(resize);
    for (const element of root.querySelectorAll('#role-review-filter, .role-page-heading')) observer.observe(element);
    window.addEventListener('resize', resize);
    const frame = requestAnimationFrame(resize);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', resize);
      cancelAnimationFrame(frame);
    };
  }, []);
  return (
    <div ref={ref} className="role-admin-list">
      {children}
    </div>
  );
}

/**
 * The queue's filters (prototype `#role-review-filter`): search, status and
 * page size, the selects applying as soon as they change; the state lives
 * in the URL, the default status (pending) and size left out.
 */
export function VerificationFilters({ q, status, size, resetHref }: { q: string; status: string; size: number; resetHref: string | null }) {
  const { t } = useI18n();
  const v = t.consoleUsers.verifications;
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const apply = (changes: Record<string, string>) => {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value === '' || (key === 'status' && value === 'pending') || (key === 'size' && value === '20')) next.delete(key);
      else next.set(key, value);
    }
    next.delete('page');
    const query = next.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  };
  return (
    <form
      id="role-review-filter"
      className="record-filter"
      onSubmit={(event) => {
        event.preventDefault();
        apply({ q: String(new FormData(event.currentTarget).get('q') ?? '').trim() });
      }}
    >
      <div className="search-small">
        <CI name="search" />
        <input key={q} type="search" name="q" aria-label={v.searchLabel} defaultValue={q} maxLength={400} placeholder={v.search} />
      </div>
      <label>
        {v.filters.status}
        <select name="status" aria-label={v.statusLabel} value={status} onChange={(event) => apply({ status: event.target.value })}>
          {(['pending', 'all', 'approved', 'rejected', 'closed'] as const).map((value) => (
            <option key={value} value={value}>
              {value === 'all' ? v.allStatuses : v.status[value]}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t.console.list.perPage}
        <select name="size" aria-label={v.sizeLabel} value={String(size)} onChange={(event) => apply({ size: event.target.value })}>
          {[20, 50, 100].map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
      <button className="btn secondary sm">{t.console.list.search}</button>
      {resetHref && (
        <Link className="text-link" href={resetHref}>
          {t.console.list.reset}
        </Link>
      )}
    </form>
  );
}

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
      id="role-review-decision"
      onSubmit={(event) => {
        event.preventDefault();
        const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
        void decide(submitter?.value === 'rejected' ? 'rejected' : 'approved');
      }}
    >
      <label htmlFor="verification-reason">
        {v.note}
        <small>
          {Array.from(note).length} / {ROLE_REASON_MAX}
        </small>
      </label>
      <textarea id="verification-reason" name="reason" rows={4} maxLength={ROLE_REASON_MAX} value={note} onChange={(event) => setNote(event.target.value)} />
      <div className="role-actions">
        <button type="submit" name="decision" value="rejected" className="btn secondary" disabled={busy !== null}>
          {busy === 'rejected' && <span className="spinner" aria-hidden="true" />}
          {v.reject}
        </button>
        <button type="submit" name="decision" value="approved" className="btn" disabled={busy !== null}>
          {busy === 'approved' ? <span className="spinner" aria-hidden="true" /> : <CI name="check" />}
          {v.approve}
        </button>
      </div>
      {error && (
        <p className="form-error role-form-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
