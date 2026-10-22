'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useI18n } from '@/lib/i18n/client';

/**
 * The password form of a link-only page (lib/http/showcase-gate.ts). A
 * correct password sets the unlock cookie; the page is then asked for
 * again and renders in full. The error says only that the password was
 * wrong: nothing about the page leaves the server before the cookie.
 */
export function ShowcaseUnlock({ slug, accent }: { slug: string; accent: string }) {
  const { t } = useI18n();
  const g = t.showcase.gate;
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || password.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/s/${encodeURIComponent(slug)}/api/unlock`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (response.ok) {
        router.refresh();
        return;
      }
      setError(response.status === 429 ? g.tooMany : g.wrong);
    } catch {
      setError(t.showcase.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex w-full max-w-[360px] flex-col gap-3">
      <label className="flex flex-col gap-1.5">
        <span className="text-[12px] font-medium text-steel">{g.passwordLabel}</span>
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="off"
          autoFocus
          maxLength={64}
          className="h-11 rounded-lg border border-line bg-card px-3.5 text-[14px] text-ink focus:outline-none"
        />
      </label>
      <button
        type="submit"
        disabled={busy || password.length === 0}
        className="h-11 rounded-lg px-4 text-[14px] font-medium text-white transition-opacity disabled:opacity-50"
        style={{ background: accent }}
      >
        {g.unlock}
      </button>
      {error ? (
        <p role="alert" className="text-[12.5px] text-rose">
          {error}
        </p>
      ) : null}
    </form>
  );
}
