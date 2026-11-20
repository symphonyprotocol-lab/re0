'use client';

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { FOLLOWUP_MAX_MENTIONS, POST_QUESTION_MAX, PRIVATE_POST_MAX_REES, type FollowupCandidate, type PrivateReeOption } from '@/lib/domain/post';
import { QUERY_BASE_FEE } from '@/lib/constants';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber } from '@/i18n/format';
import { Icon } from '@/components/ui/icons';
import { ReeAvatar } from '@/components/ui/ree-avatar';
import { useToast } from '@/components/ui/toast';
import { PrivateReePicker } from '@/components/posts/ree-picker';

export interface FollowupComposerHandle {
  /** "继续问 X": @ that Ree, then bring the box into view with the cursor in it. */
  mention: (reeId: string) => void;
}

/**
 * The box at the end of a post's thread (追问): one line until used. Typing
 * "@" or the @ button opens the first round's Rees to pick from; picked
 * ones are chips that can be removed, and the cost line says who answers
 * and what it costs the asker (谁问谁出钱). Visitors get a sign-in line.
 *
 * Under a private post (`isPrivate`, its author only) any Ree of the thread
 * may be @-mentioned, and "加 Ree" brings in new ones (up to
 * `PRIVATE_POST_MAX_REES` in the thread), sent as `addReeIds`; every price
 * shown goes along as `fees` and is held when sent, so a raised price comes
 * back to confirm again.
 */
export const FollowupComposer = forwardRef<FollowupComposerHandle, { postId: string; isPrivate?: boolean; candidates: FollowupCandidate[]; signedIn: boolean; loginHref: string; blocked: 'full' | null; onAsked: () => void }>(function FollowupComposer(
  { postId, isPrivate = false, candidates: threadRees, signedIn, loginHref, blocked, onAsked },
  ref,
) {
  const { t, locale } = useI18n();
  const f = t.posts.followupComposer;
  const toast = useToast();
  const [question, setQuestion] = useState('');
  const [mentions, setMentions] = useState<string[]>([]);
  const [picker, setPicker] = useState(false);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  /* 加 Ree (private only): Rees new to the thread, and prices the server said were raised. */
  const [added, setAdded] = useState<PrivateReeOption[]>([]);
  const [adding, setAdding] = useState(false);
  const [raised, setRaised] = useState<Map<string, number>>(() => new Map());
  const candidates = useMemo(() => (raised.size ? threadRees.map((entry) => (raised.has(entry.reeId) ? { ...entry, price: raised.get(entry.reeId)! } : entry)) : threadRees), [threadRees, raised]);
  const addedNow = raised.size ? added.map((entry) => (raised.has(entry.reeId) ? { ...entry, price: raised.get(entry.reeId)! } : entry)) : added;
  const token = useRef<string>('');
  const box = useRef<HTMLFormElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!signedIn) return;
    fetch('/api/posts/allowance', { headers: { accept: 'application/json' } })
      .then((response) => (response.ok ? (response.json() as Promise<{ balance: number }>) : null))
      .then((body) => body && setBalance(body.balance))
      .catch(() => undefined);
  }, [signedIn]);

  const open = useMemo(() => candidates.filter((entry) => !mentions.includes(entry.reeId)), [candidates, mentions]);
  const picked = mentions.map((id) => candidates.find((entry) => entry.reeId === id)).filter((entry): entry is FollowupCandidate => Boolean(entry));

  const add = (reeId: string) => {
    setMentions((current) => (current.includes(reeId) || current.length >= FOLLOWUP_MAX_MENTIONS ? current : [...current, reeId]));
    /* A typed "@" that opened the list is replaced by the chip. */
    setQuestion((current) => current.replace(/(^|\s)@$/, '$1'));
    setPicker(false);
    input.current?.focus();
  };

  useImperativeHandle(ref, () => ({
    mention(reeId: string) {
      if (candidates.some((entry) => entry.reeId === reeId)) setMentions((current) => (current.includes(reeId) ? current : [...current, reeId].slice(-FOLLOWUP_MAX_MENTIONS)));
      box.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      window.setTimeout(() => input.current?.focus({ preventScroll: true }), 250);
    },
  }), [candidates]);

  if (!signedIn) {
    return (
      <div className="fu-composer is-visitor" id="followup">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <strong className="block">{f.visitorTitle}</strong>
            <p>{f.visitorBody}</p>
          </div>
          <Link href={loginHref} className="btn btn-sm">
            {f.signIn}
          </Link>
        </div>
      </div>
    );
  }
  if (blocked === 'full') return <div className="post-state is-unmatched" id="followup">{f.full}</div>;
  if (candidates.length === 0 && !isPrivate) return null;

  const paidNames = picked.filter((entry) => entry.paid).map((entry) => entry.reeName);
  /* Private: named Rees (@ and 加 Ree) answer, else the relevant ones of the thread -- at most all of them. */
  const named = [...picked, ...addedNow];
  const cost = isPrivate
    ? named.length
      ? fill(f.privateCostNamed, { names: named.map((entry) => entry.reeName).join('、'), total: formatNumber(named.reduce((sum, entry) => sum + entry.price, 0), locale) })
      : fill(f.privateCost, { total: formatNumber(candidates.reduce((sum, entry) => sum + entry.price, 0), locale) })
    : picked.length
      ? `${fill(f.costMentioned, { names: picked.map((entry) => entry.reeName).join('、'), fee: QUERY_BASE_FEE })}${paidNames.length ? ` · ${fill(f.costPaid, { names: paidNames.join('、') })}` : ''}`
      : fill(f.costAll, { n: formatNumber(candidates.length, locale), fee: QUERY_BASE_FEE });
  const threadFull = candidates.length + added.length >= PRIVATE_POST_MAX_REES;
  const short = balance !== null && balance < QUERY_BASE_FEE;

  async function send() {
    if (!question.trim()) return setError(f.errors.empty);
    if (question.trim().length > POST_QUESTION_MAX) return setError(fill(f.errors.too_long, { n: POST_QUESTION_MAX }));
    if (!token.current) token.current = crypto.randomUUID();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/posts/${postId}/followups`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          isPrivate
            ? { question, mentionReeIds: mentions, addReeIds: added.map((entry) => entry.reeId), fees: Object.fromEntries([...candidates, ...addedNow].map((entry) => [entry.reeId, entry.price])), clientToken: token.current }
            : { question, mentionReeIds: mentions, clientToken: token.current },
        ),
      });
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (response.status === 402) {
        setBalance(Number(body.balance) || 0);
        return toast(fill(t.posts.composer.insufficient, { needed: formatNumber(Number(body.needed) || 0, locale), balance: formatNumber(Number(body.balance) || 0, locale) }));
      }
      if (body.error === 'price_changed' && Array.isArray(body.prices)) {
        /* Nothing was held: show the prices now and let the asker send again. */
        setRaised(new Map((body.prices as { reeId: string; price: number }[]).map((entry) => [entry.reeId, entry.price])));
        return setError(f.errors.price_changed);
      }
      if (!response.ok) {
        const code = String(body.error ?? '') as keyof typeof f.errors;
        return setError(code === 'too_long' ? fill(f.errors.too_long, { n: POST_QUESTION_MAX }) : (f.errors[code] ?? f.errors.failed));
      }
      setQuestion('');
      setMentions([]);
      setAdded([]);
      setRaised(new Map());
      token.current = '';
      onAsked();
    } catch {
      setError(f.errors.failed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      ref={box}
      className="fu-composer"
      id="followup"
      aria-label={f.label}
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <span className="grid size-10 place-items-center rounded-full bg-soft text-blue">
        <Icon name="reply" className="size-4" />
      </span>
      <div className="fu-form">
        {(picked.length > 0 || addedNow.length > 0) && (
          <div className="fu-chips">
            {addedNow.map((entry) => (
              <span key={entry.reeId} className="fu-chip">
                <ReeAvatar avatar={entry.reeAvatar} color={entry.reeColor} size="sm" className="size-[18px]!" />
                {entry.reeName}
                <small>{formatNumber(entry.price, locale)}</small>
                <button type="button" aria-label={fill(f.remove, { name: entry.reeName })} title={fill(f.remove, { name: entry.reeName })} onClick={() => setAdded((current) => current.filter((other) => other.reeId !== entry.reeId))}>
                  <Icon name="close" className="" />
                </button>
              </span>
            ))}
            {picked.map((entry) => (
              <span key={entry.reeId} className="fu-chip">
                <ReeAvatar avatar={entry.reeAvatar} color={entry.reeColor} size="sm" className="size-[18px]!" />
                @{entry.reeName}
                <button type="button" aria-label={fill(f.remove, { name: entry.reeName })} title={fill(f.remove, { name: entry.reeName })} onClick={() => setMentions((current) => current.filter((id) => id !== entry.reeId))}>
                  <Icon name="close" className="" />
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={input}
          className="fu-input"
          aria-label={f.label}
          placeholder={isPrivate ? f.placeholderPrivate : f.placeholder}
          value={question}
          rows={question ? 2 : 1}
          maxLength={POST_QUESTION_MAX + 50}
          onChange={(event) => {
            const value = event.target.value;
            setQuestion(value);
            setError(null);
            /* "@" at the start or after a space opens the list. */
            if (/(^|\s)@$/.test(value) && open.length) {
              setActive(0);
              setPicker(true);
            } else if (picker) setPicker(false);
          }}
          onKeyDown={(event) => {
            if (picker && open.length) {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                setActive((current) => (current + (event.key === 'ArrowDown' ? 1 : open.length - 1)) % open.length);
                return;
              }
              if (event.key === 'Enter') {
                event.preventDefault();
                add(open[Math.min(active, open.length - 1)]!.reeId);
                return;
              }
              if (event.key === 'Escape') return setPicker(false);
            }
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void send();
            }
          }}
        />
        {picker && (
          <div className="fu-picker" role="listbox" aria-label={f.pickerTitle}>
            <p>{isPrivate ? f.pickerTitlePrivate : f.pickerTitle}</p>
            {open.length === 0 && <p>{f.pickerEmpty}</p>}
            {open.map((entry, index) => (
              <button key={entry.reeId} type="button" role="option" aria-selected={index === active} className={`fu-pick${index === active ? ' is-active' : ''}`} onMouseEnter={() => setActive(index)} onClick={() => add(entry.reeId)}>
                <ReeAvatar avatar={entry.reeAvatar} color={entry.reeColor} size="sm" />
                <span className="min-w-0">
                  <strong>{entry.reeName}</strong>
                  <small>{fill(entry.paid ? f.pricePaid : f.priceFree, { n: formatNumber(entry.price, locale) })}</small>
                </span>
              </button>
            ))}
          </div>
        )}
        {error && (
          <p className="post-error" role="alert">
            {error}
          </p>
        )}
        {short && (
          <p className="post-hint">
            <Link href="/settings?tab=balance" className="text-blue hover:underline">
              {fill(f.topUp, { fee: QUERY_BASE_FEE })} → {f.topUpGo}
            </Link>
          </p>
        )}
        {adding && (
          <PrivateReePicker
            title={fill(f.addPickerTitle, { max: PRIVATE_POST_MAX_REES })}
            exclude={[...candidates.map((entry) => entry.reeId), ...added.map((entry) => entry.reeId)]}
            onPick={(option) => {
              setAdded((current) => (current.some((entry) => entry.reeId === option.reeId) || candidates.length + current.length >= PRIVATE_POST_MAX_REES ? current : [...current, option]));
              setAdding(false);
              input.current?.focus();
            }}
            onClose={() => setAdding(false)}
          />
        )}
        <div className="fu-foot">
          {isPrivate && (
            <button type="button" className="icon-btn chip-btn" data-ree-picker="" aria-expanded={adding} disabled={threadFull} title={threadFull ? f.errors.too_many_rees : undefined} onClick={() => setAdding((current) => !current)}>
              <Icon name="plus" className="" />
              {f.addRee}
            </button>
          )}
          <button type="button" className="icon-btn fu-at-btn" aria-label={f.at} title={f.at} aria-expanded={picker} disabled={open.length === 0 || mentions.length >= FOLLOWUP_MAX_MENTIONS} onClick={() => setPicker((current) => !current)}>
            <Icon name="at" className="" />
          </button>
          <small className="post-cost">{cost}</small>
          <button type="submit" className="btn btn-sm" disabled={busy || !question.trim() || short}>
            {busy ? <i className="spinner" /> : null}
            {busy ? f.sending : f.send}
          </button>
        </div>
      </div>
    </form>
  );
});
