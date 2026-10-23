'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useMemo, useRef, useState } from 'react';
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

/**
 * The detail page's Rebuild button and the list's per-row refresh icon: the
 * same action, the same floating card. A click opens the cost under the
 * trigger; confirming there queues the build, and a one-line result takes
 * the card's place -- requirement.md 5.2 asks for a definite result, not a
 * ceremony, so there is no dialog. Escape or a click outside closes it.
 *
 * The card is fixed to the viewport rather than absolute to the trigger: the
 * list sits inside an `overflow-x-auto` scroller (and a clipped panel), and an
 * absolute card hanging below the last row was cut off at the panel's edge;
 * on the detail page an inline card pushed the header apart. It is anchored
 * to the trigger's bottom-right on open and follows it through scrolls and
 * resizes, so it reads as one popover wherever it opens.
 */
export function RebuildLibraryButton(props: RebuildControlProps) {
  return <RebuildPopover {...props} variant="button" />;
}

export function RebuildLibraryControl(props: RebuildControlProps) {
  return <RebuildPopover {...props} variant="icon" />;
}

interface RebuildControlProps {
  libraryId: string;
  action: RebuildLibraryAction;
  quote: BuildQuote;
  disabled?: boolean;
}

function RebuildPopover({
  libraryId,
  action,
  quote,
  disabled = false,
  variant,
}: RebuildControlProps & { variant: 'button' | 'icon' }) {
  const { t } = useI18n();
  /* The detail page and the list word the same outcome for where each stands. */
  const copy =
    variant === 'button'
      ? (() => {
          const a = t.dashboard.libraryDetail.actions;
          return { label: a.rebuild, cancel: a.rebuildCancel, confirm: a.rebuildConfirm, working: a.rebuilding, queued: a.rebuildQueued, quota: a.rebuildQuota, failed: a.rebuildFailed };
        })()
      : (() => {
          const m = t.dashboard.libraries.manage;
          return { label: m.refresh, cancel: m.refreshCancel, confirm: m.refreshConfirm, working: m.refreshing, queued: m.refreshQueued, quota: m.refreshQuota, failed: m.refreshFailed };
        })();
  const [state, formAction, pending] = useActionState(action, null);
  const [confirming, setConfirming] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const router = useRouter();

  /* The run starts after the response; pull the page again so the banner
     and the queue show it running rather than the state before the click. */
  useEffect(() => {
    if (state?.ok) {
      setConfirming(false);
      router.refresh();
    }
    setDismissed(false);
  }, [state, router]);

  const message = state && !dismissed ? (state.ok ? copy.queued : state.error === 'quota' ? copy.quota : copy.failed) : null;

  /* Where the card goes: just under the trigger, flush with its right edge,
     never closer than 16px to the viewport's edge. Recomputed on every
     scroll (captured, so the list's own scroller counts) and resize while
     something is showing; hidden until the first measurement lands. */
  const anchor = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLElement | null>(null);
  const floating = confirming || message !== null;
  const [place, setPlace] = useState<{ top: number; right: number } | null>(null);
  useEffect(() => {
    if (!floating) {
      setPlace(null);
      return;
    }
    const update = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      setPlace({
        top: rect.bottom + 6,
        right: Math.max(16, document.documentElement.clientWidth - rect.right),
      });
    };
    const close = () => {
      if (pending) return;
      setConfirming(false);
      setDismissed(true);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (card.current?.contains(target) || anchor.current?.contains(target)) return;
      close();
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [floating, pending]);
  const floatStyle = place ? { top: place.top, right: place.right } : { visibility: 'hidden' as const };

  const toggle = () => {
    setDismissed(true);
    setConfirming((open) => !open);
  };

  return (
    <div className="flex items-center">
      {variant === 'button' ? (
        <button
          ref={anchor}
          type="button"
          aria-expanded={confirming}
          onClick={toggle}
          disabled={disabled || pending}
          className={`${SECONDARY} ${confirming ? 'border-brand/50 bg-brandsoft text-brandink' : ''}`}
        >
          {pending ? <SpinnerIcon size={14} className="motion-safe:animate-spin" /> : <RefreshIcon size={14} />}
          {copy.label}
        </button>
      ) : (
        <button
          ref={anchor}
          type="button"
          aria-label={copy.label}
          title={copy.label}
          aria-expanded={confirming}
          onClick={toggle}
          disabled={disabled || pending}
          className={`inline-flex size-[30px] shrink-0 items-center justify-center rounded-md border transition-colors disabled:opacity-40 ${
            confirming ? 'border-brand/50 bg-brandsoft text-brandink' : 'border-line bg-card text-muted hover:bg-subtle hover:text-ink'
          }`}
        >
          {pending ? <SpinnerIcon size={14} className="motion-safe:animate-spin" /> : <RefreshIcon size={14} />}
        </button>
      )}
      {confirming ? (
        <form
          ref={(node) => {
            card.current = node;
          }}
          action={formAction}
          style={floatStyle}
          className="fixed z-30 flex w-[320px] max-w-[calc(100vw-32px)] flex-col gap-2.5 rounded-md border border-line bg-card p-3 shadow-md motion-safe:animate-[popover-in_120ms_ease-out]"
        >
          <input type="hidden" name="libraryId" value={libraryId} />
          <BuildCostNotice quote={quote} />
          <span className="flex justify-end gap-2">
            <button type="button" onClick={() => setConfirming(false)} disabled={pending} className={SECONDARY}>
              {copy.cancel}
            </button>
            <button type="submit" disabled={pending || !quote.affordable} className={PRIMARY}>
              {pending ? <SpinnerIcon size={14} className="motion-safe:animate-spin" /> : <RefreshIcon size={14} />}
              {pending ? copy.working : copy.confirm}
            </button>
          </span>
        </form>
      ) : message ? (
        <span
          ref={(node) => {
            card.current = node;
          }}
          role="status"
          style={floatStyle}
          className={`fixed z-30 flex w-max max-w-[280px] items-start gap-1.5 rounded-md border border-line bg-card px-2.5 py-2 text-left text-[11px] leading-[1.45] shadow-md motion-safe:animate-[popover-in_120ms_ease-out] ${
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
