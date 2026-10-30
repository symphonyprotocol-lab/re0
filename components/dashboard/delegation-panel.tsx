'use client';

import { useActionState } from 'react';
import { followDelegationAction, type DelegationResult } from '@/app/dashboard/external-agents/actions';
import type { DelegationView } from '@/lib/application/external-agents/delegation';
import { useI18n } from '@/lib/i18n/client';
import type { Dictionary } from '@/lib/i18n/dictionary';
import { fill } from '@/lib/i18n/format';

type Words = Dictionary['dashboard']['delegation'];

/**
 * One delegation's remote task (agent-first-proposal.md 7.9): its state and
 * what the external Agent returned, framed as that Agent's output -- plain
 * text, JSON as text, files by name only (a URL an Agent sent is shown, not
 * linked) -- never as a cited answer of re0's. The owner's two buttons are
 * GetTask and CancelTask; re0 does not poll on its own.
 */
export function DelegationPanel({ delegation: initial, controls = true }: { delegation: DelegationView; controls?: boolean }) {
  const { locale, t } = useI18n();
  const d = t.dashboard.delegation;
  const [followed, follow, following] = useActionState<DelegationResult | null, FormData>(followDelegationAction, null);
  const delegation = followed?.delegation ?? initial;
  const time = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const state = d.states[delegation.state as keyof Words['states']] ?? delegation.state;

  return (
    <section className="mt-2.5 rounded-md border border-line bg-subtle/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11.5px] font-medium text-ink">{d.title}</p>
        <span
          className={`rounded-full px-2 py-0.5 text-[10.5px] font-medium ${
            delegation.state === 'SEND_FAILED' || delegation.state === 'TASK_STATE_FAILED' || delegation.state === 'TASK_STATE_REJECTED'
              ? 'bg-warnsoft text-warn'
              : delegation.terminal
                ? 'bg-brandsoft text-brandink'
                : 'bg-card text-muted'
          }`}
        >
          {state}
        </span>
      </div>
      <p className="mt-1 text-[11px] text-warn">{fill(d.untrusted, { agent: delegation.agentName })}</p>
      <dl className="mt-1.5 grid gap-x-3 gap-y-0.5 text-[11px] text-muted sm:grid-cols-[auto_1fr]">
        {delegation.remoteTaskId ? (
          <>
            <dt className="text-faint">{d.remoteTask}</dt>
            <dd className="font-mono break-all">{delegation.remoteTaskId}</dd>
          </>
        ) : null}
        {delegation.skill ? (
          <>
            <dt className="text-faint">{d.skill}</dt>
            <dd className="font-mono">{delegation.skill}</dd>
          </>
        ) : null}
        <dt className="text-faint">{d.endpoint}</dt>
        <dd className="font-mono break-all">{delegation.endpointUrl}</dd>
      </dl>

      {delegation.purged ? (
        <p className="mt-2 text-[11.5px] text-faint">{d.purged}</p>
      ) : (
        <div className="mt-2 flex flex-col gap-1.5">
          {delegation.statusMessage ? (
            <p className="text-[12px] leading-[1.6] whitespace-pre-wrap text-ink">{delegation.statusMessage}</p>
          ) : null}
          {delegation.output.map((part, index) =>
            part.kind === 'text' ? (
              <p key={index} className="text-[12px] leading-[1.6] whitespace-pre-wrap text-ink">
                {part.text}
              </p>
            ) : part.kind === 'data' ? (
              <pre key={index} className="overflow-x-auto rounded border border-line/70 bg-card p-2 font-mono text-[11px] text-ink">
                {part.json}
              </pre>
            ) : (
              <p key={index} className="text-[11.5px] break-all text-muted">
                {fill(d.file, { name: part.name, type: part.mediaType })}
                {part.url ? <span className="ml-1 font-mono text-faint">{part.url}</span> : null}
              </p>
            ),
          )}
          {!delegation.statusMessage && delegation.output.length === 0 && !delegation.error ? (
            <p className="text-[11.5px] text-faint">{d.empty}</p>
          ) : null}
          {delegation.error ? <p className="text-[11.5px] text-warn">{delegation.error}</p> : null}
        </div>
      )}

      {delegation.lastPolledAt ? (
        <p className="mt-1.5 text-[10.5px] text-faint">{fill(d.lastPolled, { time: time.format(new Date(delegation.lastPolledAt)) })}</p>
      ) : null}
      {controls && !delegation.terminal && delegation.remoteTaskId ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {(['poll', 'cancel'] as const).map((op) => (
            <form key={op} action={follow}>
              <input type="hidden" name="delegationId" value={delegation.id} />
              <input type="hidden" name="op" value={op} />
              <button
                type="submit"
                disabled={following}
                className="h-7 rounded-md border border-line bg-card px-3 text-[11.5px] text-ink transition-colors hover:bg-subtle disabled:opacity-50"
              >
                {following ? d.working : op === 'poll' ? d.refresh : d.cancel}
              </button>
            </form>
          ))}
        </div>
      ) : null}
      {followed?.error ? (
        <p role="alert" className="mt-1.5 text-[11.5px] text-warn">
          {d.errors[followed.error as keyof Words['errors']] ?? d.errors.unavailable}
        </p>
      ) : null}
    </section>
  );
}
