'use client';

import Link from 'next/link';
import Script from 'next/script';
import { useEffect, useState } from 'react';
import { SpinnerIcon } from '@/components/ui/icons';

/**
 * The page Paddle's payment links open: Paddle.js, which finds the `_ptxn`
 * query parameter and opens the overlay checkout for that transaction.
 *
 * This is the only place Paddle.js runs. It never sees a price -- the
 * transaction was created server side, priced from the Plan Version
 * (lib/infrastructure/payment/paddle) -- so nothing the browser does here can
 * change what is charged. The same page also serves the links Paddle emails
 * for a renewal whose card failed, which is why it does not require a session.
 */

interface PaddleGlobal {
  Environment: { set(environment: string): void };
  Initialize(options: {
    token: string;
    checkout?: { settings?: Record<string, unknown> };
    eventCallback?: (event: { name?: string }) => void;
  }): void;
}

declare global {
  interface Window {
    Paddle?: PaddleGlobal;
  }
}

type Phase = 'opening' | 'closed' | 'completed' | 'missing' | 'failed';

export function PaddleCheckout({
  token,
  environment,
  locale,
  labels,
}: {
  token: string;
  environment: 'sandbox' | 'production';
  /** Paddle's own locale code. */
  locale: string;
  labels: Record<Phase, string> & { reopen: string; back: string };
}) {
  const [phase, setPhase] = useState<Phase>('opening');
  /* Reopening reloads the page; the button spins until the unload lands. */
  const [reopening, setReopening] = useState(false);

  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has('_ptxn')) setPhase('missing');
  }, []);

  const initialize = () => {
    const paddle = window.Paddle;
    if (!paddle || !new URLSearchParams(window.location.search).has('_ptxn')) return;
    if (environment === 'sandbox') paddle.Environment.set('sandbox');
    paddle.Initialize({
      token,
      checkout: {
        settings: {
          displayMode: 'overlay',
          locale,
          successUrl: `${window.location.origin}/dashboard/settings?checkout=success#plan`,
        },
      },
      eventCallback: (event) => {
        if (event.name === 'checkout.completed') setPhase('completed');
        else if (event.name === 'checkout.closed') {
          setPhase((current) => (current === 'completed' ? current : 'closed'));
        }
      },
    });
  };

  return (
    <section className="mx-auto flex w-full max-w-[520px] flex-1 flex-col items-center justify-center gap-5 px-5 py-20 text-center">
      <Script
        src="https://cdn.paddle.com/paddle/v2/paddle.js"
        strategy="afterInteractive"
        onReady={initialize}
        onError={() => setPhase('failed')}
      />
      {phase === 'opening' ? (
        /* Static ring under reduced motion; the status line carries the state there. */
        <SpinnerIcon size={28} className="text-brandink motion-safe:animate-spin" />
      ) : null}
      <p className="text-[14px] leading-[1.7] text-steel" role="status" aria-busy={phase === 'opening'}>
        {labels[phase]}
      </p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        {phase === 'closed' || phase === 'failed' ? (
          <button
            type="button"
            disabled={reopening}
            aria-busy={reopening}
            onClick={() => {
              setReopening(true);
              window.location.reload();
            }}
            className="flex h-10 items-center gap-2 rounded-full bg-brand px-5 text-[13px] font-medium text-onbrand transition-colors hover:bg-brand/90 disabled:cursor-progress disabled:opacity-70"
          >
            {reopening ? <SpinnerIcon size={14} className="motion-safe:animate-spin" /> : null}
            {labels.reopen}
          </button>
        ) : null}
        <Link
          href="/dashboard/settings#plan"
          className="flex h-10 items-center rounded-full border border-line px-5 text-[13px] text-ink transition-colors hover:bg-subtle"
        >
          {labels.back}
        </Link>
      </div>
    </section>
  );
}
