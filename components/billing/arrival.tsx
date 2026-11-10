'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber } from '@/i18n/format';
import { Spinner } from '@/components/ui/icons';
import { I } from '@/components/settings/icon';

const POLL_MS = 2_000;
const GIVE_UP_MS = 90_000;

/**
 * After Paddle's overlay reports a finished payment (`?checkout=txn_…`):
 * "到账中" until the webhook has credited it, then "已到账" and the page's
 * figures refresh. Credits only ever arrive through the webhook.
 */
export function ArrivalNotice({ transactionId }: { transactionId: string }) {
  const { t, locale } = useI18n();
  const a = t.billing.arrival;
  const router = useRouter();
  const [state, setState] = useState<{ phase: 'pending' | 'done' | 'slow'; credits: number }>({ phase: 'pending', credits: 0 });

  useEffect(() => {
    let stopped = false;
    const started = Date.now();
    const poll = async () => {
      if (stopped) return;
      try {
        const response = await fetch(`/api/billing/checkout?transaction=${encodeURIComponent(transactionId)}`, { cache: 'no-store' });
        /* Signed out meanwhile: no later poll can succeed. */
        if (response.status === 401) {
          setState((current) => ({ ...current, phase: 'slow' }));
          return;
        }
        const body = (await response.json()) as { credited?: boolean; credits?: number };
        if (body.credited) {
          setState({ phase: 'done', credits: body.credits ?? 0 });
          /* Arrived: a reload of this address need not wait for it again. */
          const url = new URL(window.location.href);
          if (url.searchParams.has('checkout')) {
            url.searchParams.delete('checkout');
            window.history.replaceState(null, '', url);
          }
          router.refresh();
          return;
        }
      } catch {
        /* Keep waiting: the next poll may get through. */
      }
      if (Date.now() - started > GIVE_UP_MS) {
        setState((current) => ({ ...current, phase: 'slow' }));
        return;
      }
      setTimeout(poll, POLL_MS);
    };
    void poll();
    return () => {
      stopped = true;
    };
  }, [transactionId, router]);

  return (
    <div role="status" className={`billing-arrival ${state.phase === 'done' ? 'done' : ''}`}>
      {state.phase === 'pending' ? <Spinner /> : <I name={state.phase === 'done' ? 'check' : 'clock'} />}
      <span>{state.phase === 'done' ? fill(a.done, { n: formatNumber(state.credits, locale) }) : state.phase === 'slow' ? a.slow : a.pending}</span>
    </div>
  );
}
