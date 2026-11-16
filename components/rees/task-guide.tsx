'use client';

import { useState } from 'react';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { useNavigationRouter as useRouter } from '@/components/shell/navigation-provider';
import { TASK_HREF } from '@/lib/domain/invites';
import type { TaskGuide as Guide } from '@/lib/services/task-rewards';
import type { CheckInStatus } from '@/lib/services/check-in';
import { api } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { fill, formatDate, formatNumber } from '@/i18n/format';
import { useToast } from '@/components/ui/toast';
import { PIcon } from '@/components/rees/proto-icon';
import './task-guide.css';

/**
 * The starter task guide (docs/design/invitations.md) at the top of the Rees
 * page, where a new account lands: what each task pays, which are done, a
 * way to each, the daily check-in and the invite line. Closing it hides it
 * for good; while check-ins are left, the check-in line stays on its own.
 */
export function TaskGuide({ guide }: { guide: Guide }) {
  const { t, locale } = useI18n();
  const g = t.invites.guide;
  const router = useRouter();
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  if (hidden) return null;
  const n = (value: number) => formatNumber(value, locale);
  if (guide.checkInOnly && guide.checkIn) {
    return (
      <section className="card task-guide task-guide-compact" aria-label={g.checkIn.title}>
        <ol className="task-guide-list">
          <CheckInRow status={guide.checkIn} />
        </ol>
      </section>
    );
  }
  const done = guide.items.filter((item) => item.done).length;
  async function dismiss() {
    setBusy(true);
    const result = await api('/api/account/task-guide', { method: 'DELETE' });
    setBusy(false);
    if (!result.ok) return;
    setHidden(true);
    router.refresh();
  }
  return (
    <section className="card task-guide" aria-labelledby="task-guide-title">
      <div className="task-guide-head">
        <div>
          <p className="eyebrow">{g.eyebrow}</p>
          <h2 id="task-guide-title">
            {g.title}
            <span className="task-guide-progress mono">{fill(g.progress, { done: n(done), total: n(guide.items.length) })}</span>
          </h2>
          <p>{g.lede}</p>
        </div>
        <button type="button" className="btn secondary sm" onClick={dismiss} disabled={busy} aria-label={g.dismissLabel}>
          {g.dismiss}
        </button>
      </div>
      <ol className="task-guide-list">
        {guide.items.map((item) => {
          const copy = g.items[item.key];
          return (
            <li key={item.key} className={item.done ? 'done' : ''}>
              <span className="task-guide-check" role="img" aria-label={item.done ? g.done : g.pending}>
                <PIcon name={item.done ? 'check' : 'clock'} />
              </span>
              <div>
                <strong>{copy.title}</strong>
                <span>{copy.body}</span>
              </div>
              {item.credits !== null && <small className="mono">{fill(g.reward, { n: n(item.credits) })}</small>}
              {item.key !== 'signup' && !item.done ? (
                <Link href={TASK_HREF[item.key]} className="btn secondary sm">
                  {g.go}
                </Link>
              ) : (
                <span className="task-guide-state">{g.done}</span>
              )}
            </li>
          );
        })}
        {guide.checkIn && <CheckInRow status={guide.checkIn} />}
        {guide.invite && (
          <li className="task-guide-invite">
            <span className="task-guide-check">
              <PIcon name="users" />
            </span>
            <div>
              <strong>{g.invite.title}</strong>
              <span>{fill(guide.invite.withdrawable ? g.invite.body : g.invite.bodyGift, { n: n(guide.invite.credits) })}</span>
            </div>
            <small className="mono">{fill(g.reward, { n: n(guide.invite.credits) })}</small>
            <Link href="/settings?tab=invite" className="btn secondary sm">
              {g.invite.go}
            </Link>
          </li>
        )}
      </ol>
    </section>
  );
}

/** Today's check-in: the button while one is to be had, otherwise why not, with progress and the window's end. */
function CheckInRow({ status: initial }: { status: CheckInStatus }) {
  const { t, locale } = useI18n();
  const c = t.invites.guide.checkIn;
  const g = t.invites.guide;
  const toast = useToast();
  const router = useRouter();
  const [status, setStatus] = useState(initial);
  const [busy, setBusy] = useState(false);
  const n = (value: number) => formatNumber(value, locale);
  async function checkIn() {
    setBusy(true);
    const result = await api<{ ok?: boolean; credits?: number; status?: CheckInStatus }>('/api/account/check-in', { method: 'POST' });
    setBusy(false);
    if (result.data.status) setStatus({ ...result.data.status, windowEndsAt: new Date(result.data.status.windowEndsAt) });
    if (result.ok && result.data.credits) {
      toast(fill(c.paid, { n: n(result.data.credits) }));
      router.refresh();
    } else if (!result.data.status) toast(c.failed);
  }
  const state = status.state;
  const finished = state === 'finished' || state === 'expired' || state === 'off';
  return (
    <li className={`task-guide-check-in ${state === 'done_today' || state === 'finished' ? 'done' : ''}`}>
      <span className="task-guide-check" role="img" aria-label={state === 'available' ? g.pending : g.done}>
        <PIcon name={state === 'available' ? 'clock' : 'check'} />
      </span>
      <div>
        <strong>{c.title}</strong>
        <span>
          {state === 'available' || state === 'done_today'
            ? fill(c.progress, { used: n(status.used), max: n(status.maxDays), date: formatDate(new Date(status.windowEndsAt), locale) })
            : c[state]}
        </span>
        {!finished && <span>{fill(c.body, { months: n(status.windowMonths), n: n(status.credits), max: n(status.maxDays) })}</span>}
      </div>
      {status.credits > 0 && <small className="mono">{fill(g.reward, { n: n(status.credits) })}</small>}
      {state === 'available' ? (
        <button type="button" className="btn sm" onClick={checkIn} disabled={busy}>
          {busy ? c.busy : c.button}
        </button>
      ) : (
        <span className="task-guide-state">{state === 'done_today' ? c.doneToday : finished ? c[state] : g.done}</span>
      )}
    </li>
  );
}
