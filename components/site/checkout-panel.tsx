'use client';

import type { PriceView } from '@/lib/domain/pricing';
import { PromotionNotice } from '@/components/site/product-price';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import Script from 'next/script';
import { useNavigationRouter as useRouter } from '@/components/shell/navigation-provider';
import { useEffect, useRef, useState } from 'react';
import { PACK } from '@/lib/constants';
import { creditsFor } from '@/lib/domain/billing';
import { DEFAULT_EARNED_SETTINGS, maxDeductionMinor } from '@/lib/domain/earned';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber, formatUsd } from '@/i18n/format';
import { Icon, Spinner } from '@/components/ui/icons';

interface PaddleEvent {
  name?: string;
  data?: { transaction_id?: string };
}

interface PaddleGlobal {
  Environment: { set(environment: string): void };
  Initialize(options: { token: string; checkout?: { settings?: Record<string, unknown> }; eventCallback?: (event: PaddleEvent) => void }): void;
  Checkout: { open(options: { transactionId: string; customer?: { email: string }; settings?: Record<string, unknown> }): void; close(): void };
}

declare global {
  interface Window {
    Paddle?: PaddleGlobal;
    re0PaddleListener?: (event: PaddleEvent) => void;
  }
}

type Phase = 'idle' | 'creating' | 'open' | 'closed' | 'completed';

/**
 * The checkout page's order summary (prototype `#/checkout`): Pack quantity
 * 1–10 (kept in the URL, so signing in comes back to it), the consent box,
 * then the server creates the Paddle transaction and Paddle.js opens its
 * overlay. A finished payment goes to the billing tab, which waits for the
 * webhook to credit it. The page never sees a price Paddle charges: the
 * transaction is priced server side from the catalogue.
 */
export function CheckoutPanel({
  kind,
  price,
  quantity: initialQuantity,
  signedIn,
  email,
  planActive,
  paddle,
  pendingTransaction,
  earned = null,
}: {
  kind: 'plan' | 'pack';
  price: PriceView;
  quantity: number;
  signedIn: boolean;
  email: string | null;
  planActive: boolean;
  paddle: { clientToken: string; environment: 'sandbox' | 'production' } | null;
  pendingTransaction: string | null;
  /** Earned credits that may pay part or all of the order, and the console's rules; null when there are none to offer. */
  earned?: { deductible: number; creditsPerCent: number; maxPercent: number; minChargeMinor: number } | null;
}) {
  const { t, locale } = useI18n();
  const c = t.site.checkout;
  const router = useRouter();
  const [quantity, setQuantity] = useState(initialQuantity);
  const [consent, setConsent] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const transaction = useRef<string | null>(pendingTransaction);
  const phaseRef = useRef<Phase>('idle');
  phaseRef.current = phase;

  const money = (minor: number) => formatUsd(minor, locale);
  const subtotal = price.effectivePriceMinor * quantity;
  const credits = creditsFor({ kind, quantity }, price.credits);
  const locked = kind === 'pack' && signedIn && !planActive;
  const alreadyPlan = kind === 'plan' && planActive;

  /* Earned credits toward this order (docs/design/earned-credits.md): whole cents, at most the console's share, leaving 0 or Paddle's minimum. */
  const rules = earned
    ? { ...DEFAULT_EARNED_SETTINGS, deductEnabled: true, deductCreditsPerCent: earned.creditsPerCent, deductMaxPercent: earned.maxPercent, deductMinChargeMinor: earned.minChargeMinor }
    : null;
  const maxEarnedMinor = rules && earned ? maxDeductionMinor(subtotal, earned.deductible, rules) : 0;
  const [useEarned, setUseEarned] = useState(false);
  const [earnedInput, setEarnedInput] = useState('');
  const typedMinor = Math.round(Number(earnedInput || '0') * 100);
  let earnedMinor = useEarned && Number.isFinite(typedMinor) ? Math.min(Math.max(typedMinor, 0), maxEarnedMinor) : 0;
  const adjusted = rules !== null && earnedMinor > 0 && subtotal - earnedMinor > 0 && subtotal - earnedMinor < rules.deductMinChargeMinor;
  if (adjusted && rules) earnedMinor = Math.max(0, subtotal - rules.deductMinChargeMinor);
  const earnedCredits = earned ? earnedMinor * earned.creditsPerCent : 0;
  const payMinor = subtotal - earnedMinor;
  const paidByEarned = earnedMinor > 0 && payMinor === 0;
  const startEarned = (on: boolean) => {
    setUseEarned(on);
    if (on) setEarnedInput((maxEarnedMinor / 100).toFixed(2));
    transaction.current = null;
  };

  /* Paddle.Initialize may only run once per page, so its callback forwards to whatever this listener is now. */
  useEffect(() => {
    window.re0PaddleListener = (event: PaddleEvent) => {
      if (event.name === 'checkout.completed') {
        const id = event.data?.transaction_id ?? transaction.current;
        setPhase('completed');
        /* The overlay outlives a client-side navigation; close it so the balance tab shows. */
        window.setTimeout(() => window.Paddle?.Checkout.close(), 1_500);
        router.push(id ? `/settings?tab=balance&checkout=${encodeURIComponent(id)}` : '/settings?tab=balance');
      } else if (event.name === 'checkout.closed' && phaseRef.current !== 'completed') {
        setPhase('closed');
      }
    };
  }, [router]);

  const initialize = () => {
    const instance = window.Paddle;
    if (!instance || !paddle) return;
    if (!document.documentElement.dataset.paddleReady) {
      if (paddle.environment === 'sandbox') instance.Environment.set('sandbox');
      instance.Initialize({
        token: paddle.clientToken,
        checkout: { settings: { displayMode: 'overlay', theme: 'light', locale: locale === 'zh' ? 'zh-Hans' : 'en' } },
        eventCallback: (event) => window.re0PaddleListener?.(event),
      });
      document.documentElement.dataset.paddleReady = '1';
    }
    setReady(true);
  };

  /* A payment link from Paddle (`?_ptxn=`) opens on its own once Paddle.js initializes. */
  useEffect(() => {
    if (pendingTransaction && ready) setPhase('open');
  }, [pendingTransaction, ready]);

  const open = (id: string) => {
    if (!window.Paddle) {
      setError(c.errors.paddle_script);
      setPhase('idle');
      return;
    }
    setPhase('open');
    window.Paddle.Checkout.open({ transactionId: id, ...(email ? { customer: { email } } : {}) });
  };

  const confirm = async () => {
    setError(null);
    if (!consent) {
      setError(c.errors.consent_required);
      return;
    }
    setPhase('creating');
    try {
      const response = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind, quantity, consent: true, quoteKey: price.quoteKey, ...(earnedMinor > 0 ? { earnedMinor } : {}) }),
      });
      const body = (await response.json().catch(() => ({}))) as { transactionId?: string; purchaseId?: string; error?: keyof typeof c.errors };
      if (response.ok && body.purchaseId) {
        /* Paid in full with earned credits: nothing for Paddle to do. */
        setPhase('completed');
        router.push('/settings?tab=balance');
        router.refresh();
        return;
      }
      if (!response.ok || !body.transactionId) {
        if (response.status === 401) {
          router.push(`/login?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`);
          return;
        }
        if (body.error === 'price_changed') { setConsent(false); router.refresh(); }
        setError((body.error && c.errors[body.error]) || t.common.errors.generic);
        setPhase('idle');
        return;
      }
      transaction.current = body.transactionId;
      open(body.transactionId);
    } catch {
      setError(t.common.errors.network);
      setPhase('idle');
    }
  };

  const changeQuantity = (value: number) => {
    setQuantity(value);
    setUseEarned(false);
    transaction.current = null;
    router.replace(`/checkout?kind=pack&quantity=${value}`, { scroll: false });
  };

  return (
    <aside className="card p-6 md:p-7">
      {paddle && <Script src="https://cdn.paddle.com/paddle/v2/paddle.js" strategy="afterInteractive" onReady={initialize} onError={() => setError(c.errors.paddle_script)} />}
      <span className="eyebrow">{c.summary}</span>
      <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[22px] font-extrabold">{kind === 'plan' ? c.planName : c.packName}</h2>
        <span className="tag border-[#d8e6fb] bg-soft text-blue">{kind === 'plan' ? c.monthly : c.oneTime}</span>
      </div>
      <p className="mt-1 text-[13px] text-muted">{fill(kind === 'plan' ? c.planBody : c.packBody, { credits: formatNumber(price.credits, locale) })}</p>
      {kind === 'pack' && (
        <div className="mt-5 flex items-center justify-between gap-3">
          <label htmlFor="pack-quantity" className="text-[13px] font-semibold">
            {c.quantity}
          </label>
          <select
            id="pack-quantity"
            value={quantity}
            onChange={(event) => changeQuantity(Number(event.target.value))}
            disabled={phase === 'creating' || phase === 'open'}
            className="rounded-lg border border-line bg-white px-3 py-2 text-[13px]"
          >
            {Array.from({ length: PACK.maxQuantity }, (_, index) => index + 1).map((value) => (
              <option key={value} value={value}>
                {fill(c.packs, { n: value })}
              </option>
            ))}
          </select>
        </div>
      )}
      {price.promotional && <p className="mt-4"><PromotionNotice price={price} kind={kind} locale={locale} labels={t.site.prices} /></p>}
      <dl className="mt-5 flex flex-col gap-2.5 text-[13px]">
        <div className="flex justify-between">
          <dt className="text-muted">{c.subtotal}</dt>
          <dd className="font-mono font-semibold">{money(subtotal)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted">{c.taxes}</dt>
          <dd className="text-muted">{c.taxesNote}</dd>
        </div>
      </dl>
      {earned && signedIn && !locked && !alreadyPlan && (
        <div className="mt-4 rounded-xl border border-line bg-wash px-4 py-3 text-[12px]">
          {maxEarnedMinor > 0 ? (
            <>
              <label className="flex items-center gap-2.5 font-semibold">
                <input
                  id="checkout-use-earned"
                  type="checkbox"
                  className="size-4 flex-none accent-blue"
                  checked={useEarned}
                  disabled={phase === 'creating' || phase === 'open'}
                  onChange={(event) => startEarned(event.target.checked)}
                />
                {c.earned.toggle}
              </label>
              <p className="mt-1 text-muted">
                {fill(c.earned.available, { credits: formatNumber(earned.deductible, locale), usd: money(Math.floor(earned.deductible / earned.creditsPerCent)) })}
              </p>
              {useEarned && (
                <div className="mt-3 flex flex-col gap-2">
                  <label htmlFor="checkout-earned-amount" className="font-semibold">
                    {c.earned.amount}
                  </label>
                  <input
                    id="checkout-earned-amount"
                    inputMode="decimal"
                    value={earnedInput}
                    disabled={phase === 'creating' || phase === 'open'}
                    onChange={(event) => {
                      setEarnedInput(event.target.value.replace(/[^\d.]/g, ''));
                      transaction.current = null;
                    }}
                    onBlur={() => setEarnedInput((earnedMinor / 100).toFixed(2))}
                    className="rounded-lg border border-line bg-white px-3 py-2 font-mono text-[13px]"
                  />
                  {adjusted && rules && <p className="text-muted">{fill(c.earned.leaveMin, { min: money(rules.deductMinChargeMinor) })}</p>}
                  <p className="text-muted">{paidByEarned ? (kind === 'plan' ? c.earned.planFull : c.earned.packFull) : kind === 'plan' ? c.earned.planOnce : ''}</p>
                </div>
              )}
            </>
          ) : (
            <p className="text-muted">{c.earned.none}</p>
          )}
        </div>
      )}
      {earnedMinor > 0 && (
        <div className="mt-3 flex justify-between text-[13px]">
          <span className="text-muted">{fill(c.earned.line, { credits: formatNumber(earnedCredits, locale) })}</span>
          <span className="font-mono font-semibold text-blue">−{money(earnedMinor)}</span>
        </div>
      )}
      <hr className="my-4 border-line" />
      <div className="flex items-baseline justify-between">
        <span className="text-[13px] font-semibold">{earnedMinor > 0 ? c.earned.payNow : c.total}</span>
        <strong className="font-mono text-[30px]">{money(payMinor)}</strong>
      </div>
      <p className="text-right font-mono text-[12px] text-blue">
        {formatNumber(credits, locale)} credits{kind === 'plan' ? ` / ${c.perCycle}` : ''}
      </p>

      {locked ? (
        <div className="mt-6">
          <p role="alert" className="rounded-lg border border-[#f1d4d4] bg-[#fff3f3] px-3 py-2 text-[12px] text-red">
            {c.locked}
          </p>
          <Link href="/checkout?kind=plan" className="btn mt-3 w-full">
            {c.subscribeFirst}
          </Link>
        </div>
      ) : alreadyPlan ? (
        <Link href="/settings?tab=balance" className="btn mt-6 w-full">
          {c.hasPlan}
        </Link>
      ) : (
        <div className="mt-6">
          <label className="flex items-start gap-2.5 text-[12px] leading-relaxed text-muted">
            <input type="checkbox" className="mt-0.5 size-4 flex-none accent-blue" checked={consent} onChange={(event) => setConsent(event.target.checked)} disabled={!signedIn} />
            <span>
              {kind === 'plan' ? c.consentPlan : c.consentPack}{' '}
              <Link href="/legal/terms" className="text-link" target="_blank">
                {c.terms}
              </Link>{' '}
              ·{' '}
              <Link href="/legal/privacy" className="text-link" target="_blank">
                {c.privacy}
              </Link>
            </span>
          </label>
          {error && (
            <p role="alert" className="mt-3 rounded-lg border border-[#f1d4d4] bg-[#fff3f3] px-3 py-2 text-[12px] text-red">
              {error}
            </p>
          )}
          {phase === 'closed' && <p className="mt-3 text-[12px] text-muted">{c.closed}</p>}
          {phase === 'completed' ? (
            <p className="mt-4 flex items-center gap-2 text-[13px] font-semibold text-green" role="status">
              <Spinner />
              {c.completed}
            </p>
          ) : phase === 'closed' && transaction.current ? (
            <button type="button" className="btn mt-4 min-h-12 w-full text-[14px]" onClick={() => open(transaction.current!)}>
              {c.reopen}
              <Icon name="arrow" />
            </button>
          ) : (
            <button
              type="button"
              className="btn mt-4 min-h-12 w-full text-[14px]"
              disabled={!signedIn || (!paidByEarned && (!paddle || !ready)) || phase === 'creating' || phase === 'open'}
              onClick={confirm}
            >
              {phase === 'creating' || phase === 'open' || (!paidByEarned && signedIn && paddle && !ready) ? <Spinner /> : null}
              {paidByEarned
                ? phase === 'creating' ? c.earned.paying : c.earned.payWithEarned
                : phase === 'creating' || phase === 'open' ? c.opening : signedIn && paddle && !ready ? c.loading : c.confirm}
              {phase === 'idle' && (ready || paidByEarned) && <Icon name="arrow" />}
            </button>
          )}
          {!paddle && signedIn && <p className="mt-2 text-[11px] text-muted">{c.errors.payments_unavailable}</p>}
        </div>
      )}
      <p className="mt-4 flex items-center justify-center gap-1.5 text-[11px] text-muted">
        <Icon name="lock" className="size-3.5" />
        {c.secure}
      </p>
    </aside>
  );
}
