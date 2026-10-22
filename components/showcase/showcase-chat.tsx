'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ClaimText } from '@/components/site/claim-text';
import type { WidgetStreamLine } from '@/lib/http/widget-ask';
import type { WidgetSource } from '@/lib/domain/widget';
import { useI18n } from '@/lib/i18n/client';
import { fill } from '@/lib/i18n/format';

/**
 * The Q&A under a showcase page's introduction: the widget's transcript
 * (public/embed-app.js), in the page rather than in an iframe, reading the
 * same newline-delimited stream from the page's own ask route. No history
 * is sent -- each question stands alone, as in the playground -- and every
 * sentence shown was bound to a retrieved passage before it was sent.
 */

type Outcome = Extract<WidgetStreamLine, { type: 'outcome' }>['kind'];

/** Once a visitor has left their contact, the page does not ask again for a day. */
const LEAD_WINDOW_MS = 24 * 60 * 60 * 1000;

interface Turn {
  id: number;
  question: string;
  claims: { text: string; marks: number[] }[];
  sources: WidgetSource[];
  rewrite: string | null;
  /** Null until the stream said how it ended. */
  outcome: Outcome | null;
  /** The server's refusal before the stream opened, by error code. */
  refused: string | null;
  exchangeId: string | null;
  feedback: 'helpful' | 'unhelpful' | null;
  done: boolean;
}

function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search;
  } catch {
    return url;
  }
}

export function ShowcaseChat({
  slug,
  accent,
  ready,
  preview,
  starterQuestions,
  fallbackCta,
  ownerName,
}: {
  slug: string;
  accent: string;
  ready: boolean;
  /** The owner looking at an unpublished page: the composer is shown, the ask route would refuse. */
  preview: boolean;
  starterQuestions: string[];
  /** Where to send a visitor the library could not answer. */
  fallbackCta: { label: string; url: string } | null;
  /** Who a lead's contact goes to, for the privacy line. */
  ownerName: string;
}) {
  const { t } = useI18n();
  const s = t.showcase;
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const counter = useRef(0);
  /* The lead form: opened under one turn, shown once per browser per day. */
  const [leadFor, setLeadFor] = useState<number | null>(null);
  const [leadSent, setLeadSent] = useState(false);
  const [leadBusy, setLeadBusy] = useState(false);
  const [leadError, setLeadError] = useState<string | null>(null);
  const leadKey = `re0-showcase-lead:${slug}`;

  useEffect(() => {
    try {
      const last = Number(sessionStorage.getItem(leadKey) ?? 0);
      if (Date.now() - last < LEAD_WINDOW_MS) setLeadSent(true);
    } catch {
      /* no storage: ask once per page load */
    }
  }, [leadKey]);

  async function sendLead(turn: Turn, form: HTMLFormElement) {
    const data = new FormData(form);
    setLeadBusy(true);
    setLeadError(null);
    try {
      const response = await fetch(`/s/${encodeURIComponent(slug)}/api/lead`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: data.get('email'),
          name: data.get('name'),
          message: data.get('message'),
          exchangeId: turn.exchangeId,
        }),
      });
      if (!response.ok) {
        let field: string | undefined;
        try {
          field = ((await response.json()) as { error?: { field?: string } }).error?.field;
        } catch {
          /* no body */
        }
        setLeadError(field === 'email' ? s.lead.emailInvalid : response.status === 429 ? s.rateLimited : s.error);
        return;
      }
      setLeadSent(true);
      setLeadFor(null);
      try {
        sessionStorage.setItem(leadKey, String(Date.now()));
      } catch {
        /* nothing to remember with */
      }
    } catch {
      setLeadError(s.error);
    } finally {
      setLeadBusy(false);
    }
  }

  useEffect(() => {
    if (turns.length > 0) end.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [turns]);

  const patch = (id: number, change: (turn: Turn) => Turn) =>
    setTurns((current) => current.map((turn) => (turn.id === id ? change(turn) : turn)));

  async function ask(question: string) {
    const id = (counter.current += 1);
    setTurns((current) => [
      ...current,
      {
        id,
        question,
        claims: [],
        sources: [],
        rewrite: null,
        outcome: null,
        refused: null,
        exchangeId: null,
        feedback: null,
        done: false,
      },
    ]);
    setBusy(true);
    const indexOf = new Map<string, number>();
    try {
      const response = await fetch(`/s/${encodeURIComponent(slug)}/api/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question }),
      });
      if (!response.ok || !response.body) {
        let code = 'error';
        try {
          code = String(((await response.json()) as { error?: { code?: string } }).error?.code ?? 'error');
        } catch {
          /* no body */
        }
        patch(id, (turn) => ({ ...turn, refused: code, done: true }));
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const handle = (line: WidgetStreamLine) => {
        if (line.type === 'exchange') patch(id, (turn) => ({ ...turn, exchangeId: line.id }));
        else if (line.type === 'sources') {
          line.sources.forEach((source, at) => source.chunkIds.forEach((chunkId) => indexOf.set(chunkId, at)));
          patch(id, (turn) => ({ ...turn, sources: line.sources }));
        } else if (line.type === 'claim') {
          const marks = [...new Set(line.chunkIds.map((chunkId) => indexOf.get(chunkId)).filter((n): n is number => n !== undefined))];
          patch(id, (turn) => ({ ...turn, claims: [...turn.claims, { text: line.text, marks }] }));
        } else if (line.type === 'rewrite') patch(id, (turn) => ({ ...turn, rewrite: line.query }));
        else if (line.type === 'outcome') patch(id, (turn) => ({ ...turn, outcome: line.kind }));
      };
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const raw of lines) if (raw.trim()) handle(JSON.parse(raw) as WidgetStreamLine);
      }
      if (buffer.trim()) handle(JSON.parse(buffer) as WidgetStreamLine);
      patch(id, (turn) => ({ ...turn, done: true }));
    } catch {
      patch(id, (turn) => ({ ...turn, refused: 'error', done: true }));
    } finally {
      setBusy(false);
      input.current?.focus();
    }
  }

  /* Asking is off while the page is unpublished or its library is not indexed yet. */
  const canAsk = !preview && ready;

  function submit(event: FormEvent) {
    event.preventDefault();
    const question = draft.trim();
    if (!question || busy || !canAsk) return;
    setDraft('');
    void ask(question);
  }

  /** A starter question asks at once; when asking is off it fills the composer, so the owner still sees what a visitor gets. */
  function pick(question: string) {
    if (canAsk) {
      void ask(question);
      return;
    }
    setDraft(question);
    input.current?.focus();
  }

  async function rate(turn: Turn, feedback: 'helpful' | 'unhelpful') {
    if (!turn.exchangeId) return;
    const next = turn.feedback === feedback ? null : feedback;
    patch(turn.id, (current) => ({ ...current, feedback: next }));
    try {
      await fetch(`/s/${encodeURIComponent(slug)}/api/feedback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ exchangeId: turn.exchangeId, feedback: next }),
      });
    } catch {
      /* the thumbs stay as shown; a lost vote is not the visitor's problem */
    }
  }

  const noteFor = (turn: Turn): string | null => {
    if (turn.refused) {
      return turn.refused === 'quota_exceeded' ? s.limitReached : turn.refused === 'rate_limited' ? s.rateLimited : s.error;
    }
    if (!turn.done) return null;
    switch (turn.outcome) {
      case 'not_ready':
        return s.notReady;
      case 'unavailable':
        return s.unavailable;
      case 'no_context':
        return s.noContext;
      case 'degraded':
        return turn.claims.length === 0 ? s.degraded : null;
      default:
        return null;
    }
  };

  return (
    <>
      {/* While nothing has been asked, the starter questions fill the body;
          the first question replaces them with the transcript. */}
      {turns.length === 0 && starterQuestions.length > 0 ? (
        <div className="flex flex-col gap-2.5 border-t border-line px-5 py-4 sm:px-6">
          <p className="text-[12px] text-muted">{s.tryAsking}</p>
          <ul className="flex flex-wrap gap-2">
            {starterQuestions.map((question) => (
              <li key={question}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => pick(question)}
                  className="rounded-md border border-line bg-subtle px-3 py-1.5 text-left text-[13px] leading-[1.45] text-ink transition-colors hover:border-steel hover:bg-card focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50"
                  style={{ ['--tw-ring-color' as string]: accent }}
                >
                  {question}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className={`flex flex-1 flex-col gap-4 ${turns.length > 0 ? 'border-t border-line px-5 py-5 sm:px-6' : ''}`} aria-live="polite">
        {turns.map((turn) => {
          const note = noteFor(turn);
          const titled = new Map<string, number>();
          turn.sources.forEach((source) => titled.set(source.title, (titled.get(source.title) ?? 0) + 1));
          return (
            <div key={turn.id} className="flex flex-col gap-2">
              <p
                className="max-w-[88%] self-end rounded-xl rounded-br-sm px-3.5 py-2.5 text-[14px] leading-[1.5] text-white whitespace-pre-wrap"
                style={{ background: accent }}
              >
                {turn.question}
              </p>
              <div className="flex max-w-[94%] flex-col gap-2 self-start rounded-xl rounded-bl-sm bg-subtle px-4 py-3 text-[14px] leading-[1.6] text-ink">
                {!turn.done && turn.claims.length === 0 ? (
                  /* Three dots in the page's accent, rising in turn: the
                     widget's typing indicator (public/embed-app.css
                     `.re0-thinking`), drawn here with the page's own colour. */
                  <p role="status" className="flex items-center gap-2 text-[12.5px] text-muted">
                    <span>{s.thinking}</span>
                    <span aria-hidden className="flex items-center gap-1">
                      {[0, 160, 320].map((delay) => (
                        <span
                          key={delay}
                          className="size-1.5 animate-bounce rounded-full motion-reduce:animate-none"
                          style={{ background: accent, animationDelay: `${delay}ms` }}
                        />
                      ))}
                    </span>
                  </p>
                ) : null}
                {turn.claims.map((claim, at) => (
                  <p key={at} className="whitespace-pre-line">
                    <ClaimText text={claim.text} />
                    {claim.marks.map((mark) => (
                      <sup key={mark} className="ml-px text-[10.5px]" style={{ color: accent }}>
                        [{mark + 1}]
                      </sup>
                    ))}
                  </p>
                ))}
                {note ? (
                  <p className="text-[12.5px] text-muted">
                    {note}
                    {turn.outcome === 'no_context' && fallbackCta ? (
                      <>
                        {' '}
                        <a href={fallbackCta.url} target="_blank" rel="noopener nofollow" className="underline" style={{ color: accent }}>
                          {fill(s.noContextCta, { label: fallbackCta.label })}
                        </a>
                      </>
                    ) : null}
                  </p>
                ) : null}
                {turn.done && turn.rewrite && turn.outcome !== 'no_context' ? (
                  <p className="text-[12px] text-muted">{fill(s.searchedAs, { query: turn.rewrite })}</p>
                ) : null}
                {turn.done && turn.sources.length > 0 ? (
                  <div className="mt-1 flex flex-col gap-1 border-t border-line pt-2">
                    <p className="text-[11.5px] font-medium text-muted">{s.sources}</p>
                    {turn.sources.map((source, at) => (
                      <a
                        key={source.url}
                        href={source.url}
                        target="_blank"
                        rel="noopener nofollow"
                        className="flex items-center justify-between gap-3 rounded-md border border-line bg-card px-2.5 py-1.5 text-[12.5px] text-ink hover:border-steel"
                      >
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate font-medium">
                            [{at + 1}] {source.title}
                          </span>
                          {source.section && source.section !== source.title ? (
                            <span className="truncate text-[11px] text-muted">{source.section}</span>
                          ) : (titled.get(source.title) ?? 0) > 1 ? (
                            <span className="truncate text-[11px] text-muted">{pathOf(source.url)}</span>
                          ) : null}
                        </span>
                        <span className="shrink-0 text-[11px] font-medium" style={{ color: accent }}>
                          {s.open}
                        </span>
                      </a>
                    ))}
                  </div>
                ) : null}
                {turn.done && !preview && (turn.outcome === 'no_context' || turn.feedback === 'unhelpful') ? (
                  leadSent ? (
                    <p className="text-[12px] text-muted">{s.lead.sent}</p>
                  ) : leadFor === turn.id ? (
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        void sendLead(turn, event.currentTarget);
                      }}
                      className="flex flex-col gap-2 rounded-md border border-line bg-card p-3"
                    >
                      <p className="text-[12.5px] font-medium text-ink">{s.lead.title}</p>
                      <input
                        name="email"
                        type="email"
                        required
                        maxLength={254}
                        placeholder={s.lead.email}
                        aria-label={s.lead.email}
                        className="h-9 rounded-md border border-line bg-card px-3 text-[13px] text-ink"
                      />
                      <input
                        name="name"
                        maxLength={60}
                        placeholder={s.lead.name}
                        aria-label={s.lead.name}
                        className="h-9 rounded-md border border-line bg-card px-3 text-[13px] text-ink"
                      />
                      <textarea
                        name="message"
                        maxLength={1000}
                        defaultValue={turn.question}
                        aria-label={s.lead.message}
                        className="min-h-[64px] rounded-md border border-line bg-card px-3 py-2 text-[13px] text-ink"
                      />
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="submit"
                          disabled={leadBusy}
                          className="h-9 rounded-md px-3.5 text-[13px] font-medium text-white disabled:opacity-50"
                          style={{ background: accent }}
                        >
                          {s.lead.submit}
                        </button>
                        <button type="button" onClick={() => setLeadFor(null)} className="text-[12px] text-muted hover:text-ink">
                          {s.lead.cancel}
                        </button>
                        {leadError ? <span className="text-[12px] text-rose">{leadError}</span> : null}
                      </div>
                      <p className="text-[11px] text-muted">{fill(s.lead.privacy, { name: ownerName })}</p>
                    </form>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setLeadError(null);
                        setLeadFor(turn.id);
                      }}
                      className="self-start text-[12.5px] underline underline-offset-2"
                      style={{ color: accent }}
                    >
                      {s.lead.prompt}
                    </button>
                  )
                ) : null}
                {turn.done && turn.exchangeId && (turn.outcome === 'answer' || turn.outcome === 'degraded') ? (
                  <div className="flex items-center gap-2 text-[11.5px] text-muted">
                    {turn.feedback ? <span>{s.thanks}</span> : null}
                    <button
                      type="button"
                      onClick={() => void rate(turn, 'helpful')}
                      aria-pressed={turn.feedback === 'helpful'}
                      className={`rounded-md border px-2 py-0.5 transition-colors ${turn.feedback === 'helpful' ? 'border-current text-ink' : 'border-line hover:text-ink'}`}
                    >
                      {s.helpful}
                    </button>
                    <button
                      type="button"
                      onClick={() => void rate(turn, 'unhelpful')}
                      aria-pressed={turn.feedback === 'unhelpful'}
                      className={`rounded-md border px-2 py-0.5 transition-colors ${turn.feedback === 'unhelpful' ? 'border-current text-ink' : 'border-line hover:text-ink'}`}
                    >
                      {s.unhelpful}
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
        <div ref={end} />
      </div>

      {/* The composer is the panel's footer. It stays in reach while a long
          transcript scrolls, on the panel's own background rather than a
          band of its own. */}
      <form
        onSubmit={submit}
        className="sticky bottom-0 flex flex-col gap-2 rounded-b-xl border-t border-line bg-card/95 px-5 py-4 backdrop-blur sm:px-6"
      >
        <div className="flex gap-2">
          <input
            ref={input}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={busy}
            maxLength={2000}
            autoComplete="off"
            placeholder={s.placeholder}
            aria-label={s.placeholder}
            className="h-11 min-w-0 flex-1 rounded-md border border-line bg-card px-3.5 text-[14px] text-ink placeholder:text-muted/70 focus:ring-2 focus:outline-none"
            style={{ ['--tw-ring-color' as string]: accent }}
          />
          <button
            type="submit"
            disabled={busy || !canAsk || draft.trim().length === 0}
            className="h-11 shrink-0 rounded-md px-4 text-[14px] font-medium text-white transition-opacity disabled:opacity-50"
            style={{ background: accent }}
          >
            {s.send}
          </button>
        </div>
        {preview ? (
          <p className="text-[11.5px] text-muted">{s.previewChat}</p>
        ) : !ready ? (
          <p className="text-[11.5px] text-muted">{s.notReady}</p>
        ) : null}
      </form>
    </>
  );
}
