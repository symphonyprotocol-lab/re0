'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useMemo, useState } from 'react';
import { CircleCheckIcon, CircleXIcon, RefreshIcon, SpinnerIcon } from '@/components/ui/icons';
import { PRIMARY, SECONDARY } from '@/components/dashboard/library-manage';
import type { RebuildLibraryActionResult } from '@/app/dashboard/libraries/[libraryId]/actions';
import type { BuildQuote } from '@/lib/application/plans/build-quota';
import { useI18n } from '@/lib/i18n/client';
import { fill } from '@/lib/i18n/format';

export type RebuildLibraryAction = (
  previous: RebuildLibraryActionResult | null,
  form: FormData,
) => Promise<RebuildLibraryActionResult>;

/**
 * What a build costs, said at the moment it is about to be queued.
 *
 * library-build-billing.md 4.1 wants the price in front of the owner before
 * anything is reserved; the wizard shows the same figures beside the form,
 * and the rebuild controls show them inside their confirmation so a refresh
 * is never queued without the formula, the cap and the balance in view.
 */
function BuildCostNotice({ quote }: { quote: BuildQuote }) {
  const { locale, t } = useI18n();
  const cost = t.dashboard.newLibrary.buildCost;
  const number = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  return (
    <div className="flex flex-col gap-1 text-left">
      <p className="text-[12px] font-medium text-ink">{cost.title}</p>
      <p className="text-[11px] leading-[1.5] text-muted">{cost.description}</p>
      <ul className="mt-0.5 flex flex-col gap-1 text-[11px] leading-[1.5] text-steel">
        <li>
          {fill(cost.formula, {
            base: number.format(quote.rates.baseCalls),
            tokens: number.format(quote.rates.tokensPerCall),
            pages: number.format(quote.rates.pagesPerCall),
          })}
        </li>
        <li>{fill(cost.max, { calls: number.format(quote.maxCalls) })}</li>
        <li className={quote.affordable ? undefined : 'text-rose'}>
          {fill(cost.remaining, {
            plan: number.format(quote.planAllowanceRemaining),
            addon: number.format(quote.addonBalanceRemaining),
          })}
          {quote.affordable ? null : ` ${cost.insufficient}`}
        </li>
        {quote.mode === 'shadow' ? <li className="text-muted">{cost.shadow}</li> : null}
      </ul>
    </div>
  );
}

/** The detail page's Rebuild button: a click opens the cost, a second one queues. */
export function RebuildLibraryButton({
  libraryId,
  action,
  quote,
  disabled = false,
}: {
  libraryId: string;
  action: RebuildLibraryAction;
  quote: BuildQuote;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const a = t.dashboard.libraryDetail.actions;
  const [state, formAction, pending] = useActionState(action, null);
  const [confirming, setConfirming] = useState(false);
  const router = useRouter();

  /* The run starts after the response; pull the page again so the banner
     and the queue show it running rather than the state before the click. */
  useEffect(() => {
    if (state?.ok) {
      setConfirming(false);
      router.refresh();
    }
  }, [state, router]);

  return (
    <div className="flex flex-col items-end gap-1.5">
      {confirming ? (
        <form action={formAction} className="flex w-[340px] max-w-full flex-col gap-2.5 rounded-md border border-line bg-subtle p-3">
          <input type="hidden" name="libraryId" value={libraryId} />
          <BuildCostNotice quote={quote} />
          <span className="flex justify-end gap-2">
            <button type="button" onClick={() => setConfirming(false)} disabled={pending} className={SECONDARY}>
              {a.rebuildCancel}
            </button>
            <button type="submit" disabled={pending || !quote.affordable} className={PRIMARY}>
              {pending ? <SpinnerIcon size={14} className="motion-safe:animate-spin" /> : <RefreshIcon size={14} />}
              {pending ? a.rebuilding : a.rebuildConfirm}
            </button>
          </span>
        </form>
      ) : (
        <button type="button" onClick={() => setConfirming(true)} disabled={disabled} className={SECONDARY}>
          <RefreshIcon size={14} />
          {a.rebuild}
        </button>
      )}
      {state ? (
        <span
          role="status"
          className={`max-w-[340px] text-right text-[11px] leading-[1.5] ${
            state.ok ? 'text-brandink' : 'text-rose'
          }`}
        >
          {state.ok ? a.rebuildQueued : state.error === 'quota' ? a.rebuildQuota : a.rebuildFailed}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The list's per-row refresh: the same action as the detail page's Rebuild
 * button, drawn as an icon beside the row (next to files and delete). The
 * icon opens the cost under the row; confirming there queues the build, and
 * the one-line result replaces it -- requirement.md 5.2 asks for a definite
 * result, not a ceremony, so there is no dialog.
 */
export function RebuildLibraryControl({
  libraryId,
  action,
  quote,
  disabled = false,
}: {
  libraryId: string;
  action: RebuildLibraryAction;
  quote: BuildQuote;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const m = t.dashboard.libraries.manage;
  const [state, formAction, pending] = useActionState(action, null);
  const [confirming, setConfirming] = useState(false);
  const router = useRouter();

  useEffect(() => {
    if (state?.ok) {
      setConfirming(false);
      router.refresh();
    }
  }, [state, router]);

  const message = state
    ? state.ok
      ? m.refreshQueued
      : state.error === 'quota'
        ? m.refreshQuota
        : m.refreshFailed
    : null;

  return (
    <div className="relative flex items-center">
      <button
        type="button"
        aria-label={m.refresh}
        title={m.refresh}
        aria-expanded={confirming}
        onClick={() => setConfirming((open) => !open)}
        disabled={disabled || pending}
        className="inline-flex size-[30px] shrink-0 items-center justify-center rounded-md border border-line bg-card text-muted transition-colors hover:bg-subtle hover:text-ink disabled:opacity-40"
      >
        {pending ? <SpinnerIcon size={14} className="motion-safe:animate-spin" /> : <RefreshIcon size={14} />}
      </button>
      {confirming ? (
        <form
          action={formAction}
          className="absolute top-full right-0 z-20 mt-1 flex w-[320px] max-w-[calc(100vw-32px)] flex-col gap-2.5 rounded-md border border-line bg-card p-3 shadow-md"
        >
          <input type="hidden" name="libraryId" value={libraryId} />
          <BuildCostNotice quote={quote} />
          <span className="flex justify-end gap-2">
            <button type="button" onClick={() => setConfirming(false)} disabled={pending} className={SECONDARY}>
              {m.refreshCancel}
            </button>
            <button type="submit" disabled={pending || !quote.affordable} className={PRIMARY}>
              {pending ? <SpinnerIcon size={14} className="motion-safe:animate-spin" /> : <RefreshIcon size={14} />}
              {pending ? m.refreshing : m.refreshConfirm}
            </button>
          </span>
        </form>
      ) : message ? (
        <span
          role="status"
          className={`absolute top-full right-0 z-10 mt-1 flex w-max max-w-[240px] items-start gap-1.5 rounded-md border border-line bg-card px-2 py-1.5 text-left text-[10.5px] leading-[1.45] shadow-md ${
            state?.ok ? 'text-brandink' : 'text-rose'
          }`}
        >
          {state?.ok ? <CircleCheckIcon size={13} className="mt-px shrink-0" /> : <CircleXIcon size={13} className="mt-px shrink-0" />}
          {message}
        </span>
      ) : null}
    </div>
  );
}
