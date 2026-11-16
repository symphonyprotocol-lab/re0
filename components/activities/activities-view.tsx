'use client';

import { useState } from 'react';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { useNavigationRouter as useRouter } from '@/components/shell/navigation-provider';
import { TASK_HREF, type InvitePanelCopy } from '@/lib/domain/invites';
import type { Activities } from '@/lib/services/task-rewards';
import type { CheckInStatus } from '@/lib/services/check-in';
import { api } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { fill, formatDate, formatNumber } from '@/i18n/format';
import { useToast } from '@/components/ui/toast';
import { PIcon } from '@/components/rees/proto-icon';
import { InviteCopy } from '@/components/settings/invite-copy';
import '@/components/rees/ree-pages.css';
import '@/components/rees/owned-rees.css';
import './activities.css';

/** The invite block's figures, decided on the server with the invite tab's own rule (`invitePanelCopy`). */
export interface InviteSummary {
  credits: number;
  link: string;
  copy: InvitePanelCopy;
  ownWithdrawable: number;
  ownCap: number;
}

/**
 * `/activities` (docs/design/invitations.md): the daily check-in, the
 * starter tasks and a short invite block, in the styles of the task guide
 * that used to sit on the Rees page. Never dismissed; it exists while an
 * activity is available (the page redirects otherwise), and says so when
 * nothing more can be claimed today.
 */
export function ActivitiesView({ activities, invite }: { activities: Activities; invite: InviteSummary }) {
  const { t, locale } = useI18n();
  const a = t.invites.activities;
  const n = (value: number) => formatNumber(value, locale);
  const tasks = activities.tasks;
  const done = tasks.filter((item) => item.done).length;
  /* Registering is always there and always done: with nothing else, no task pays anything now. */
  const noTasks = tasks.length === 1;
  return (
    <main className="page owned-rees-page activities-page">
      <div className="page-head">
        <div>
          <p className="eyebrow">{a.eyebrow}</p>
          <h1>{a.title}</h1>
          <p>{a.lede}</p>
        </div>
      </div>

      {!activities.state.claimable && (
        <p role="status" className="activities-nothing">
          <PIcon name="check" />
          {a.nothing}
        </p>
      )}

      <section className="card task-guide" aria-labelledby="activities-check-in">
        <div className="task-guide-head">
          <div>
            <h2 id="activities-check-in">{a.checkIn.title}</h2>
          </div>
        </div>
        <ol className="task-guide-list">
          <CheckInRow status={activities.checkIn} othersAvailable={tasks.some((item) => !item.done)} />
        </ol>
      </section>

      <section className="card task-guide" aria-labelledby="activities-tasks">
        <div className="task-guide-head">
          <div>
            <h2 id="activities-tasks">
              {a.tasks.title}
              {!noTasks && <span className="task-guide-progress mono">{fill(a.tasks.progress, { done: n(done), total: n(tasks.length) })}</span>}
            </h2>
            <p>{noTasks ? a.tasks.none : done === tasks.length ? a.tasks.allDone : a.tasks.lede}</p>
          </div>
        </div>
        <ol className="task-guide-list">
          {tasks.map((item) => {
            const copy = a.tasks.items[item.key];
            return (
              <li key={item.key} className={item.done ? 'done' : ''}>
                <span className="task-guide-check" role="img" aria-label={item.done ? a.done : a.pending}>
                  <PIcon name={item.done ? 'check' : 'clock'} />
                </span>
                <div>
                  <strong>{copy.title}</strong>
                  <span>{copy.body}</span>
                </div>
                {item.credits !== null && <small className="mono">{fill(a.reward, { n: n(item.credits) })}</small>}
                {item.key !== 'signup' && !item.done ? (
                  <Link href={TASK_HREF[item.key]} className="btn secondary sm">
                    {a.go}
                  </Link>
                ) : (
                  <span className="task-guide-state">{a.done}</span>
                )}
              </li>
            );
          })}
        </ol>
      </section>

      <InviteBlock invite={invite} />
    </main>
  );
}

/** Today's check-in: the button while one is to be had, otherwise why not, with progress and the window's end. */
function CheckInRow({ status: initial, othersAvailable }: { status: CheckInStatus; othersAvailable: boolean }) {
  const { t, locale } = useI18n();
  const a = t.invites.activities;
  const c = a.checkIn;
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
      /*
       * The balance, the note and the navigation dot follow -- unless that was
       * the last check-in and no task is left: the page would then be gone on
       * the refresh, so it keeps the finished state until the next navigation.
       */
      const checkInLeft = result.data.status?.state === 'available' || result.data.status?.state === 'done_today';
      if (checkInLeft || othersAvailable) router.refresh();
    } else if (!result.data.status) toast(c.failed);
  }
  const state = status.state;
  const date = formatDate(new Date(status.windowEndsAt), locale);
  const used = { used: n(status.used), max: n(status.maxDays) };
  const note =
    state === 'available'
      ? fill(c.body, { months: n(status.windowMonths), n: n(status.credits), max: n(status.maxDays) })
      : state === 'done_today'
        ? c.doneTodayNote
        : state === 'finished'
          ? fill(c.finishedNote, { max: n(status.maxDays) })
          : state === 'expired'
            ? fill(c.expiredNote, { months: n(status.windowMonths), date })
            : c.offNote;
  const open = state === 'available' || state === 'done_today';
  return (
    <li className={`task-guide-check-in ${state === 'available' ? '' : 'done'}${state === 'off' || state === 'expired' ? ' closed' : ''}`}>
      <span className="task-guide-check" role="img" aria-label={state === 'available' ? a.pending : a.done}>
        <PIcon name={state === 'available' ? 'clock' : 'check'} />
      </span>
      <div>
        <strong>{open ? fill(c.progress, { ...used, date }) : state === 'off' && status.used === 0 ? c.off : fill(c.used, used)}</strong>
        <span>{note}</span>
      </div>
      {status.credits > 0 && open && <small className="mono">{fill(a.reward, { n: n(status.credits) })}</small>}
      {state === 'available' ? (
        <button type="button" className="btn sm" onClick={checkIn} disabled={busy}>
          {busy ? c.busy : c.button}
        </button>
      ) : (
        <span className="task-guide-state">{state === 'done_today' ? c.doneToday : c[state]}</span>
      )}
    </li>
  );
}

/** A short invite block: what an invitation pays, the account's own progress, the link; the full tab is in settings. */
function InviteBlock({ invite }: { invite: InviteSummary }) {
  const { t, locale } = useI18n();
  const a = t.invites.activities.invite;
  const p = t.invites.panel;
  const n = (value: number) => formatNumber(value, locale);
  const { copy } = invite;
  const withdrawableNow = copy.withdrawableNote && copy.status === null;
  const status =
    copy.status === 'closed'
      ? p.closed
      : copy.status === 'gift_only'
        ? p.giftOnly
        : copy.status === 'site_quota_used'
          ? p.quotaUsed
          : copy.status === 'own_cap_reached'
            ? fill(p.ownCapReached, { cap: n(invite.ownCap) })
            : null;
  return (
    <section className="card task-guide activities-invite" aria-labelledby="activities-invite">
      <div className="task-guide-head">
        <div>
          <h2 id="activities-invite">{a.title}</h2>
          <p>{invite.credits > 0 ? fill(withdrawableNow ? a.body : a.bodyGift, { n: n(invite.credits) }) : p.ledeOff}</p>
          {status && (
            <p role="status" className="activities-invite-status">
              {status}
            </p>
          )}
          {copy.progress && <p className="mono">{fill(p.ownProgress, { used: n(Math.min(invite.ownWithdrawable, invite.ownCap)), cap: n(invite.ownCap) })}</p>}
        </div>
      </div>
      {copy.status !== 'closed' && (
        <div className="activities-invite-link">
          <input readOnly value={invite.link} aria-label={p.link} />
          <InviteCopy link={invite.link} />
        </div>
      )}
      <Link href="/settings?tab=invite" className="text-link activities-invite-more">
        {a.details}
        <PIcon name="arrow" />
      </Link>
    </section>
  );
}
