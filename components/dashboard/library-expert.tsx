'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useState } from 'react';
import { Badge, PANEL } from '@/components/dashboard/ui';
import { AREA, PRIMARY, ResultLine, SECONDARY } from '@/components/dashboard/library-manage';
import { AwardIcon, CheckIcon, CircleXIcon, SpinnerIcon } from '@/components/ui/icons';
import type { ExpertApplicationActionResult } from '@/app/dashboard/libraries/[libraryId]/actions';
import {
  EXPERT_CHECKS,
  EXPERT_NOTE_MAX_LENGTH,
  type ExpertApplicationStatus,
  type ExpertCheck,
} from '@/lib/domain/expert-library';
import { useI18n } from '@/lib/i18n/client';
import { fill } from '@/lib/i18n/format';

export type ExpertFormAction = (
  previous: ExpertApplicationActionResult | null,
  form: FormData,
) => Promise<ExpertApplicationActionResult>;

/** What the server-rendered page hands the panel; dates as ISO strings. */
export interface ExpertPanelProps {
  libraryId: string;
  taggedAt: string | null;
  checks: Record<ExpertCheck, boolean>;
  earning: boolean;
  blocker: string | null;
  reapplyAllowedAt: string | null;
  pending: { id: string; createdAt: string; note: string | null } | null;
  latest: {
    status: ExpertApplicationStatus;
    decisionReason: string | null;
    decidedAt: string | null;
    createdAt: string;
  } | null;
  history: {
    id: string;
    status: ExpertApplicationStatus;
    decisionReason: string | null;
    decidedAt: string | null;
    createdAt: string;
  }[];
  canEdit: boolean;
  applyAction: ExpertFormAction;
  withdrawAction: ExpertFormAction;
}

/**
 * The expert-library panel on a library's page (expert-library-prd.md 5):
 * where the library stands, the three preconditions each as it stands now,
 * and the one verb that applies -- apply, or withdraw. The verbs post to
 * actions that re-check the role and every precondition; a viewer is shown
 * the state and no buttons.
 */
export function LibraryExpertPanel(props: ExpertPanelProps) {
  const { t, locale } = useI18n();
  const e = t.dashboard.libraryDetail.expert;
  const stamp = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const when = (value: string | null) => (value ? stamp.format(new Date(value)) : '—');

  const status: 'tagged' | 'pending' | 'none' = props.taggedAt
    ? 'tagged'
    : props.pending
      ? 'pending'
      : 'none';

  /* The headline: tagged and earning, tagged but idle, waiting, or the last word. */
  const headline = (() => {
    if (status === 'tagged') {
      return props.earning
        ? { title: e.taggedTitle, body: fill(e.taggedEarning, { when: when(props.taggedAt) }) }
        : {
            title: e.taggedTitle,
            body: fill(e.taggedIdle, {
              when: when(props.taggedAt),
              missing: EXPERT_CHECKS.filter((check) => !props.checks[check])
                .map((check) => e.checks[check])
                .join(e.listSeparator),
            }),
          };
    }
    if (status === 'pending') {
      return { title: e.pendingTitle, body: fill(e.pendingBody, { when: when(props.pending!.createdAt) }) };
    }
    if (props.latest?.status === 'rejected') {
      return {
        title: e.rejectedTitle,
        body: fill(e.rejectedBody, { reason: props.latest.decisionReason ?? '—', when: when(props.latest.decidedAt) }),
      };
    }
    if (props.latest?.status === 'revoked') {
      return {
        title: e.revokedTitle,
        body: fill(e.revokedBody, { reason: props.latest.decisionReason ?? '—', when: when(props.latest.decidedAt) }),
      };
    }
    return { title: e.noneTitle, body: e.noneBody };
  })();

  return (
    <section className={`${PANEL} flex flex-col gap-4 p-6`}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-[240px] flex-1 flex-col gap-1">
          <h2 className="flex items-center gap-2 text-[15px] font-medium text-ink">
            <AwardIcon size={16} className="text-brandink" />
            {e.title}
            {status === 'tagged' ? <Badge tone="brand">{e.badge}</Badge> : null}
            {status === 'pending' ? <Badge tone="neutral">{e.pendingBadge}</Badge> : null}
          </h2>
          <p className="text-[11px] leading-[1.6] text-muted">{e.description}</p>
        </div>
        {/* A tagged library has nothing to apply for; the headline says so. */}
        {props.canEdit && status !== 'tagged' ? (
          <ExpertVerb
            libraryId={props.libraryId}
            mode={status === 'pending' ? 'withdraw' : 'apply'}
            disabled={status === 'none' && props.blocker !== null}
            action={status === 'pending' ? props.withdrawAction : props.applyAction}
          />
        ) : null}
      </div>

      <div className="rounded-md border border-line bg-subtle px-3.5 py-3">
        <p className="text-[12px] font-medium text-ink">{headline.title}</p>
        <p className="mt-0.5 text-[11px] leading-[1.6] text-muted">{headline.body}</p>
      </div>

      <ul className="grid gap-2 sm:grid-cols-3">
        {EXPERT_CHECKS.map((check) => (
          <li
            key={check}
            className="flex items-start gap-2 rounded-md border border-line px-3 py-2.5 text-[11.5px]"
          >
            <span className={`mt-px shrink-0 ${props.checks[check] ? 'text-brandink' : 'text-rose'}`}>
              {props.checks[check] ? <CheckIcon size={14} /> : <CircleXIcon size={14} />}
            </span>
            <span className="flex flex-col gap-0.5">
              <span className="font-medium text-ink">{e.checks[check]}</span>
              <span className="text-[10.5px] leading-[1.5] text-muted">
                {props.checks[check] ? e.checkOk : e.checkMissing[check]}
              </span>
            </span>
          </li>
        ))}
      </ul>

      {status === 'none' && props.canEdit && props.blocker ? (
        <p className="text-[11px] leading-[1.6] text-muted">
          {props.blocker === 'cooldown' && props.reapplyAllowedAt
            ? fill(e.blockers.cooldown, { when: when(props.reapplyAllowedAt) })
            : (e.blockers[props.blocker as keyof typeof e.blockers] ?? e.blockers.unavailable)}
        </p>
      ) : null}

      {props.history.length > 0 ? (
        <div className="overflow-x-auto rounded-md border border-line">
          <table className="w-full min-w-[480px] border-collapse text-left text-[12px]">
            <thead>
              <tr className="bg-subtle text-[11px] font-medium text-muted">
                {e.historyColumns.map((column) => (
                  <th key={column} scope="col" className="px-3.5 py-2.5">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {props.history.map((row) => (
                <tr key={row.id} className="border-t border-line">
                  <td className="px-3.5 py-2.5 text-steel">{when(row.createdAt)}</td>
                  <td className="px-3.5 py-2.5 text-ink">{e.statuses[row.status]}</td>
                  <td className="px-3.5 py-2.5 text-steel">{when(row.decidedAt)}</td>
                  <td className="px-3.5 py-2.5 text-steel">{row.decisionReason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

/**
 * The one verb: apply opens an inline confirmation with the optional note;
 * withdraw confirms and posts. The result is spoken under the button and the
 * page is pulled again so the headline follows.
 */
function ExpertVerb({
  libraryId,
  mode,
  disabled,
  action,
}: {
  libraryId: string;
  mode: 'apply' | 'withdraw';
  disabled: boolean;
  action: ExpertFormAction;
}) {
  const { t } = useI18n();
  const e = t.dashboard.libraryDetail.expert;
  const [state, formAction, pending] = useActionState(action, null);
  const [confirming, setConfirming] = useState(false);
  const router = useRouter();

  useEffect(() => {
    if (state?.ok) {
      setConfirming(false);
      router.refresh();
    }
  }, [state, router]);

  return (
    <div className="flex flex-col items-end gap-1.5">
      {confirming ? (
        <form
          action={formAction}
          className="flex w-[min(360px,80vw)] flex-col gap-2 rounded-md border border-line bg-subtle p-3"
        >
          <input type="hidden" name="libraryId" value={libraryId} />
          <p className="text-[11px] leading-[1.5] text-steel">
            {mode === 'apply' ? e.applyConfirm : e.withdrawConfirm}
          </p>
          {mode === 'apply' ? (
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-steel">{e.noteLabel}</span>
              <textarea
                name="note"
                maxLength={EXPERT_NOTE_MAX_LENGTH}
                placeholder={e.notePlaceholder}
                className={AREA}
              />
            </label>
          ) : null}
          <span className="flex justify-end gap-2">
            <button type="button" onClick={() => setConfirming(false)} disabled={pending} className={SECONDARY}>
              {e.cancel}
            </button>
            <button
              type="submit"
              disabled={pending}
              className={mode === 'withdraw' ? `${PRIMARY} bg-rose hover:bg-rose/90` : PRIMARY}
            >
              {pending ? <SpinnerIcon size={14} className="motion-safe:animate-spin" /> : <AwardIcon size={14} />}
              {pending ? e.working : mode === 'apply' ? e.applySubmit : e.withdrawSubmit}
            </button>
          </span>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          disabled={disabled}
          className={mode === 'apply' ? PRIMARY : SECONDARY}
        >
          <AwardIcon size={14} />
          {mode === 'apply' ? e.apply : e.withdraw}
        </button>
      )}
      {state ? (
        <span className="max-w-[360px] text-right">
          <ResultLine ok={state.ok}>
            {state.ok
              ? state.action === 'withdraw'
                ? e.withdrawn
                : e.applied
              : (e.errors[state.error as keyof typeof e.errors] ?? e.errors.unavailable)}
          </ResultLine>
        </span>
      ) : null}
    </div>
  );
}
