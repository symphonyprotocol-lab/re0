'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { useI18n } from '@/i18n/client';
import { fill, formatDate, formatNumber } from '@/i18n/format';
import { Spinner } from '@/components/ui/icons';

interface Redeemed {
  kind: 'plan' | 'pack';
  credits: number;
  plan: { startsAt: string; endsAt: string; months: number; queued: boolean } | null;
}

/** As people type: upper case, dashes every four characters (a prefix's own dashes kept). */
function shape(value: string): string {
  const parts = value.toUpperCase().replace(/[^A-Z0-9-]/g, '').split('-');
  return parts.map((part, index) => (index === parts.length - 1 ? (part.match(/.{1,4}/g) ?? ['']).join('-') : part)).join('-');
}

/**
 * The balance tab's 兑换码 card (docs/design/redeem-codes.md 6.2): a code in,
 * then what it gave or why not. Each submission carries its own request id,
 * so a double click or a retry after a dropped response redeems once.
 */
export function RedeemCard({ initialCode = '' }: { initialCode?: string }) {
  const { t, locale } = useI18n();
  const r = t.billing.redeem;
  const router = useRouter();
  const [code, setCode] = useState(shape(initialCode));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const request = useRef<{ code: string; id: string } | null>(null);
  const n = (value: number) => formatNumber(value, locale);
  const date = (value: string) => formatDate(value, locale);

  const success = (result: Redeemed) => {
    if (result.kind === 'pack') return fill(r.success.pack, { credits: n(result.credits) });
    const plan = result.plan!;
    return plan.queued
      ? fill(r.success.planQueued, { start: date(plan.startsAt), until: date(plan.endsAt) })
      : fill(r.success.plan, { until: date(plan.endsAt), credits: n(result.credits) });
  };
  const failure = (body: { error?: string; retryAfter?: number; startsAt?: string }) => {
    const errors = r.errors as Record<string, string>;
    const template = (body.error && errors[body.error]) || r.errors.generic;
    return fill(template, { minutes: Math.max(1, Math.ceil((body.retryAfter ?? 60) / 60)), date: body.startsAt ? date(body.startsAt) : '' });
  };

  const submit = async () => {
    const value = code.trim();
    if (!value || busy) return;
    /* The same code submitted again keeps its request id until it gets a definite answer. */
    if (request.current?.code !== value) request.current = { code: value, id: crypto.randomUUID() };
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch('/api/billing/redeem', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: value, requestId: request.current.id }),
      });
      const body = (await response.json().catch(() => ({}))) as Redeemed & { error?: string; retryAfter?: number; startsAt?: string };
      /* Only a definite answer retires the id: after a 5xx or a timeout the redemption may have committed, and a retry must replay it. */
      if (response.status < 500) request.current = null;
      if (!response.ok) {
        setMessage({ ok: false, text: failure(body) });
        return;
      }
      setMessage({ ok: true, text: success(body) });
      setCode('');
      router.refresh();
    } catch {
      setMessage({ ok: false, text: r.errors.generic });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card redeem-card mt24" id="redeem" aria-labelledby="redeem-title">
      <div>
        <h3 id="redeem-title">{r.title}</h3>
        <p>{r.hint}</p>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="sr-only" htmlFor="redeem-code">
          {r.label}
        </label>
        <input
          id="redeem-code"
          value={code}
          onChange={(event) => setCode(shape(event.target.value))}
          placeholder={r.placeholder}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={60}
        />
        <button type="submit" className="btn" disabled={busy || !code.trim()}>
          {busy && <Spinner />}
          {busy ? r.submitting : r.submit}
        </button>
      </form>
      {message && (
        <p className={`redeem-message ${message.ok ? 'ok' : 'error'}`} role={message.ok ? 'status' : 'alert'}>
          {message.text}
        </p>
      )}
    </section>
  );
}
