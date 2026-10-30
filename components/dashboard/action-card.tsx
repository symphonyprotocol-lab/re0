'use client';

import { useActionState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  confirmPendingAction,
  rejectPendingAction,
  type DecideResult,
} from '@/app/dashboard/actions/actions';
import { formatBytes } from '@/components/dashboard/pdf-uploader';
import type { ActionState, ActionSummary } from '@/lib/domain/agent-action';
import type { WorkbenchAction } from '@/lib/http/playground-stream';
import { useI18n } from '@/lib/i18n/client';
import type { Dictionary } from '@/lib/i18n/dictionary';
import { fill } from '@/lib/i18n/format';

type Words = Dictionary['dashboard']['agentActions'];

/** What will be done, worded from the server's summary -- never from model text (proposal 5.3). */
export function actionSentence(summary: ActionSummary, a: Words): string {
  const channel = (ref: ActionSummary['to']) =>
    ref ? fill(a.channelRef, { visibility: ref.visibility === 'public' ? a.public : a.private, slug: ref.slug }) : a.noChannel;
  switch (summary.tool) {
    case 'create_asset':
      return fill(a.what.create_asset, { source: summary.source?.location ?? '' });
    case 'refresh_asset':
      return fill(a.what.refresh_asset, { asset: summary.asset?.publicId ?? '' });
    case 'create_channel':
      return fill(a.what.create_channel, {
        visibility: summary.channel?.visibility === 'private' ? a.private : a.public,
        slug: summary.channel?.slug ?? '',
        title: summary.channel?.title ?? '',
      });
    case 'move_asset':
      return fill(a.what.move_asset, { asset: summary.asset?.publicId ?? '', from: channel(summary.from), to: channel(summary.to) });
  }
}

function costLine(summary: ActionSummary, a: Words): string {
  if (summary.calls.max === 0) return a.costNone;
  return summary.calls.min === summary.calls.max
    ? fill(a.costExact, { n: String(summary.calls.max) })
    : fill(a.costRange, { min: String(summary.calls.min), max: String(summary.calls.max) });
}

/**
 * The confirmation card (agent-first-proposal.md 5.2): what, on which asset
 * or channel, the estimated Calls and capacity, whether it makes content
 * public -- and the owner's two buttons. Confirming posts the id and the
 * digest of exactly these parameters; the server runs it once.
 */
export function ActionCard({
  action,
  origin = null,
  taskId = null,
}: {
  action: WorkbenchAction;
  origin?: 'workbench' | 'a2a' | null;
  taskId?: string | null;
}) {
  const { locale, t } = useI18n();
  const a = t.dashboard.agentActions;
  const router = useRouter();
  const [confirmed, confirm, confirming] = useActionState<DecideResult | null, FormData>(confirmPendingAction, null);
  const [rejected, reject, rejecting] = useActionState<DecideResult | null, FormData>(rejectPendingAction, null);
  const decided = confirmed ?? rejected;
  const state: ActionState = decided?.state ?? action.state;
  const reason = decided?.reason ?? action.error;
  const busy = confirming || rejecting;

  /* The cards beside the conversation follow what was just done. */
  useEffect(() => {
    if (decided?.state) router.refresh();
  }, [decided?.state, router]);

  const summary = action.summary;
  const time = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <article className="rounded-md border border-line bg-card p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12px] font-medium text-ink">{a.tools[summary.tool]}</p>
        <span
          className={`rounded-full px-2 py-0.5 text-[10.5px] font-medium ${
            state === 'pending'
              ? 'bg-warnsoft text-warn'
              : state === 'confirmed'
                ? 'bg-brandsoft text-brandink'
                : 'bg-subtle text-muted'
          }`}
        >
          {a.states[state]}
        </span>
      </div>
      <p className="mt-1.5 text-[12.5px] leading-[1.6] text-ink">{actionSentence(summary, a)}</p>
      <dl className="mt-2 grid gap-x-4 gap-y-1 text-[11.5px] text-muted sm:grid-cols-[auto_1fr]">
        <dt className="text-faint">{a.cost}</dt>
        <dd>{costLine(summary, a)}</dd>
        {summary.capacityRemainingBytes !== null || summary.assetBytes !== null ? (
          <>
            <dt className="text-faint">{a.capacity}</dt>
            <dd>
              {[
                summary.assetBytes !== null ? fill(a.assetSize, { size: formatBytes(summary.assetBytes) }) : null,
                summary.capacityRemainingBytes !== null
                  ? fill(a.capacityLeft, { left: formatBytes(summary.capacityRemainingBytes) })
                  : null,
              ]
                .filter(Boolean)
                .join('; ')}
            </dd>
          </>
        ) : null}
      </dl>
      <p className={`mt-1.5 text-[11.5px] font-medium ${summary.makesPublic ? 'text-warn' : 'text-muted'}`}>
        {summary.makesPublic ? a.makesPublic : a.staysPrivate}
      </p>
      {origin ? <p className="mt-1 text-[11px] text-faint">{a.origins[origin]}</p> : null}
      {taskId ? (
        <p className="mt-1 text-[11px] text-faint">
          {a.viewTask}: <Link href="/dashboard/a2a" className="font-mono underline-offset-2 hover:underline">{taskId}</Link>
        </p>
      ) : null}

      {state === 'pending' ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <form action={confirm}>
            <input type="hidden" name="actionId" value={action.id} />
            <input type="hidden" name="digest" value={action.digest} />
            <button
              type="submit"
              disabled={busy}
              className="h-8 rounded-md bg-brand px-3.5 text-[12px] font-medium text-onbrand transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {confirming ? a.working : a.confirm}
            </button>
          </form>
          <form action={reject}>
            <input type="hidden" name="actionId" value={action.id} />
            <button
              type="submit"
              disabled={busy}
              className="h-8 rounded-md border border-line px-3.5 text-[12px] text-ink transition-colors hover:bg-subtle disabled:opacity-50"
            >
              {a.reject}
            </button>
          </form>
          <span className="text-[11px] text-faint">{fill(a.expires, { time: time.format(new Date(action.expiresAt)) })}</span>
        </div>
      ) : null}

      {state === 'confirmed' ? <p className="mt-2 text-[11.5px] text-brandink">{a.confirmedNote}</p> : null}
      {state === 'failed' ? <p className="mt-2 text-[11.5px] text-warn">{fill(a.failedNote, { reason: reason ?? '' })}</p> : null}
      {state === 'rejected' ? <p className="mt-2 text-[11.5px] text-muted">{a.rejectedNote}</p> : null}
      {state === 'expired' ? <p className="mt-2 text-[11.5px] text-muted">{a.expiredNote}</p> : null}
      {decided?.error && decided.error !== 'expired' ? (
        <p role="alert" className="mt-2 text-[11.5px] text-warn">
          {a.errors[decided.error as keyof Words['errors']] ?? a.errors.unavailable}
        </p>
      ) : null}
    </article>
  );
}
