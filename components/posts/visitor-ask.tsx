'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { POST_QUESTION_MAX } from '@/lib/domain/post';
import { FINGERPRINT_HEADER, type VisitorAskStatus, type VisitorAskView } from '@/lib/domain/visitor-ask';
import { browserFingerprint } from '@/lib/client/fingerprint';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber } from '@/i18n/format';
import { Icon } from '@/components/ui/icons';

/** How often the box looks again while a question is in review or being answered, and for how long at most. */
const POLL_MS = 4_000;
const POLL_FOR_MS = 5 * 60_000;

type ErrorCode = keyof ReturnType<typeof useI18n>['t']['posts']['visitorAsk']['errors'];

/**
 * 免登录提问 on a share page whose owner lets visitors ask (lib/domain/
 * visitor-ask.ts): the box ree-ask.tsx shows a signed-out visitor in place
 * of 登录后提问. What goes in is said first -- a public post by 访客, the
 * owner paying -- with this browser's questions left today. Below it, the
 * questions this browser asked in the last days, each with where it stands
 * and, once given, this Ree's answer; the box looks again while one is in
 * review or being answered. Whatever stops the visitor (their limit, the
 * owner's balance, the owner turning it off) is said in words, with
 * 登录后提问 to carry on. The text is the box's own draft (`text`), so
 * signing in keeps it.
 */
export function VisitorAsk({ slug, name, text, onTextChange, loginHref, onSignIn, head }: {
  slug: string;
  name: string;
  text: string;
  onTextChange: (value: string) => void;
  loginHref: string;
  onSignIn: () => void;
  head: ReactNode;
}) {
  const { t, locale } = useI18n();
  const v = t.posts.visitorAsk;
  const [status, setStatus] = useState<VisitorAskStatus | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<ErrorCode | null>(null);
  const pollUntil = useRef(0);
  const url = `/api/share/${encodeURIComponent(slug)}/ask`;

  const load = useCallback(async () => {
    try {
      const fingerprint = await browserFingerprint();
      const response = await fetch(url, { headers: { accept: 'application/json', [FINGERPRINT_HEADER]: fingerprint }, cache: 'no-store' });
      if (response.ok) setStatus((await response.json()) as VisitorAskStatus);
    } catch {
      /* The box stays as it was; the next look may work. */
    }
  }, [url]);

  useEffect(() => {
    void load();
  }, [load]);

  const waiting = status?.asked.some((entry) => entry.state === 'reviewing' || entry.state === 'answering') ?? false;
  useEffect(() => {
    if (!waiting) return;
    if (!pollUntil.current) pollUntil.current = Date.now() + POLL_FOR_MS;
    const timer = setInterval(() => {
      if (Date.now() > pollUntil.current) {
        clearInterval(timer);
        return;
      }
      void load();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, load]);

  const send = async () => {
    if (sending) return;
    if (!text.trim()) {
      setError('empty');
      return;
    }
    setSending(true);
    setError(null);
    try {
      const fingerprint = await browserFingerprint();
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: text, fingerprint, lang: locale === 'en' ? 'en' : 'zh' }),
      });
      const body = (await response.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!response.ok) {
        setError(body.error && body.error in v.errors ? (body.error as ErrorCode) : 'generic');
        await load();
        return;
      }
      onTextChange('');
      pollUntil.current = Date.now() + POLL_FOR_MS;
      await load();
    } catch {
      setError('generic');
    } finally {
      setSending(false);
    }
  };

  /* A limit already reached is said before anyone types; one hit while sending, after. */
  const stop: ErrorCode | null = error ?? (status?.blocked ?? null);
  const blocked = Boolean(status?.blocked);
  const signIn = (
    <Link rel="nofollow" href={loginHref} className={blocked ? 'btn btn-sm ml-auto' : 'text-link text-[12px]'} onClick={onSignIn}>
      {blocked ? v.signIn : v.signInInstead}
    </Link>
  );

  return (
    <div className="post-form visitor-ask">
      {head}
      <textarea
        aria-label={fill(t.posts.ask.heading, { name })}
        placeholder={fill(t.posts.ask.placeholder, { name })}
        value={text}
        maxLength={POST_QUESTION_MAX + 50}
        disabled={blocked}
        onChange={(event) => {
          onTextChange(event.target.value);
          if (error) setError(null);
        }}
      />
      <p className="post-hint">{fill(v.notice, { name })}</p>
      {stop && (
        <p className="post-error" role="alert">
          {v.errors[stop]}
        </p>
      )}
      <div className="post-composer-foot">
        {status && !blocked && <small className="post-cost">{fill(v.remaining, { n: formatNumber(status.remaining, locale) })}</small>}
        {signIn}
        {!blocked && (
          <button type="button" className="btn btn-sm" disabled={sending || !status} onClick={() => void send()}>
            {sending ? v.sending : v.send}
          </button>
        )}
      </div>
      {status && status.asked.length > 0 && (
        <section className="visitor-asked" aria-label={v.mine}>
          <h3>{v.mine}</h3>
          <ul>
            {status.asked.map((entry) => (
              <Asked key={entry.id} entry={entry} name={name} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Asked({ entry, name }: { entry: VisitorAskView; name: string }) {
  const { t } = useI18n();
  const v = t.posts.visitorAsk;
  const working = entry.state === 'reviewing' || entry.state === 'answering';
  return (
    <li className={`visitor-asked-item is-${entry.state}`}>
      <div className="visitor-asked-head">
        <p className="visitor-asked-question">{entry.question}</p>
        <span className="visitor-asked-state">
          {working && <Icon name="clock" className="size-3" />}
          {v.states[entry.state]}
        </span>
      </div>
      {entry.state === 'answered' && entry.answer && (
        <>
          <p className="visitor-asked-answer">{entry.answer}</p>
          <Link href={`/p/${entry.id}`} className="text-link text-[12px]">
            {v.readAll}
            <Icon name="chevronRight" className="size-3" />
          </Link>
        </>
      )}
      {entry.state === 'no_answer' && <p className="post-hint">{fill(v.noAnswer, { name })}</p>}
      {entry.state === 'rejected' && <p className="post-hint">{v.rejected}</p>}
    </li>
  );
}
