'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';

import { useRouter } from 'next/navigation';
import { ActionCard } from '@/components/dashboard/action-card';
import { formatBytes } from '@/components/dashboard/pdf-uploader';
import { ClaimText } from '@/components/site/claim-text';
import { SignInDialog } from '@/components/site/sign-in-dialog';
import { Re0Mark, RotateCwIcon } from '@/components/ui/icons';
import { useI18n } from '@/lib/i18n/client';
import type { Dictionary } from '@/lib/i18n/dictionary';
import type {
  PlaygroundGather,
  PlaygroundModel,
  PlaygroundOutcome,
  PlaygroundRouting,
  PlaygroundSource,
  PlaygroundStep,
  PlaygroundUIMessage,
  WorkbenchAction,
  WorkbenchListingPart,
} from '@/lib/http/playground-stream';
import { fill } from '@/lib/i18n/format';

/**
 * Playground transcript.
 *
 * requirement.md 5.1 makes this the only entry point allowed to generate prose,
 * and puts eight hard rules on it. The live path runs through POST
 * /api/playground: the server routes the question to a library (the web
 * entry's auto-routing of architecture.md 9.6), retrieves through the shared
 * function, and streams back parts. What renders here follows the same rules
 * the backend enforces:
 *
 * - rule 2: zero retrieved chunks renders the no-context card -- the model
 *   was never called, and nothing here pretends otherwise.
 * - rule 5: every factual sentence carries footnotes that resolve to the
 *   retrieved chunks; a degraded answer shows the chunks and no prose.
 *
 * The stream carries no model text part, so there is nothing here that could
 * render unbound prose even by accident: a claim exists on the client only
 * after the server bound it. Sentences therefore appear one at a time rather
 * than character by character -- the visible unit of streaming is the unit
 * rule 5 can vouch for.
 */

/**
 * The question, and the few turns before it.
 *
 * `useChat` would post the whole transcript as messages. What is sent instead
 * is the question plus, for the last few finished turns, what the visitor saw:
 * the question, the bound sentences of the answer, and the libraries it drew
 * on. The server shows them only to whatever resolves a follow-up -- the
 * planner, or the rewrite on a miss -- and never to the answering call, which
 * rule 4 keeps to this request's passages (lib/domain/generation.ts
 * `normaliseHistory` clips them again there). `pinned` is read at send time,
 * so unpinning mid-session takes effect on the next question without a new
 * transport.
 */
function playgroundTransport(
  pinned: { current: string | null },
  workbench: { current: string | null } | null,
) {
  return new DefaultChatTransport<PlaygroundUIMessage>({
    /* The workbench is the same loop with the owner's tools (agent-first-proposal.md 4.5). */
    api: workbench ? '/api/agent' : '/api/playground',
    prepareSendMessagesRequest: ({ messages }) => {
      const last = messages[messages.length - 1];
      return {
        body: workbench
          ? { question: textOf(last), history: historyOf(messages.slice(0, -1)), conversationId: workbench.current }
          : {
              question: textOf(last),
              libraryId: pinned.current,
              history: historyOf(messages.slice(0, -1)),
            },
      };
    },
  });
}

function textOf(message: PlaygroundUIMessage | undefined): string {
  return (message?.parts ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join(' ')
    .trim();
}

/** How many earlier turns ride along; the server keeps the same number. */
const HISTORY_TURNS = 3;

/** Each finished question-and-answer pair, newest last: what the visitor was shown. */
function historyOf(messages: PlaygroundUIMessage[]) {
  const turns: {
    question: string;
    answer: string;
    libraries: { libraryId: string; title: string }[];
  }[] = [];
  messages.forEach((message, at) => {
    if (message.role !== 'assistant') return;
    const asked = messages[at - 1];
    if (!asked || asked.role !== 'user') return;
    const turn = readTurn(message);
    if (turn.outcome === null) return;
    turns.push({
      question: textOf(asked),
      answer: turn.claims.map((entry) => entry.claim).join(' '),
      libraries: (turn.gather?.libraries ?? [])
        .filter((library) => library.confirmed)
        .map((library) => ({ libraryId: library.libraryId, title: library.title })),
    });
  });
  return turns.slice(-HISTORY_TURNS);
}

function AssistantMark() {
  return (
    <span
      aria-hidden
      className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border border-line bg-subtle text-brandink"
    >
      <Re0Mark size={18} />
    </span>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <p className="max-w-[80%] rounded-lg rounded-br-[4px] bg-bubble px-4 py-3 text-[13px] leading-[1.6] text-white">
        {text}
      </p>
    </div>
  );
}

/** Assistant turns are full-width rows with a mark, as in the reference chat. */
function AssistantRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <AssistantMark />
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">{children}</div>
    </div>
  );
}

/**
 * A tool call, collapsed by default.
 *
 * `<details>` rather than a state hook: the disclosure is the whole
 * interaction, and the element already answers to the keyboard and to
 * assistive technology without any of it being written here.
 */
function ToolCall({
  name,
  params,
  open = false,
  running = false,
}: {
  name: string;
  params: readonly (readonly [string, string])[];
  open?: boolean;
  /** The call has been made and its result is not back yet. */
  running?: boolean;
}) {
  return (
    <details open={open} className="group rounded-md border border-line/70 bg-tray p-2.5">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
        <span className="flex items-center gap-2">
          <code className="font-mono text-[11.5px] font-medium text-ink">{name}</code>
          {running ? (
            <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-faint" />
          ) : null}
        </span>
        <span
          aria-hidden
          className="text-[10px] text-faint transition-transform group-open:rotate-180"
        >
          ▾
        </span>
      </summary>
      <dl className="mt-1.5 flex flex-col gap-1">
        {params.map(([k, v]) => (
          <div key={k} className="flex gap-2">
            <dt className="font-mono text-[11px] text-faint">{k}:</dt>
            <dd className="font-mono text-[11px] break-all text-muted">{v}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

function WarnCard({ title, body }: { title: string; body: string }) {
  return (
    <article className="rounded-md rounded-bl-[4px] border border-warnsoft bg-warnsoft/50 p-3.5">
      <p className="text-[12.5px] font-medium text-warn">{title}</p>
      <p className="mt-1.5 text-[12px] leading-[1.75] text-muted">{body}</p>
    </article>
  );
}

/** What one assistant turn accumulated, gathered out of its stream parts. */
interface Turn {
  routing: PlaygroundRouting | null;
  gather: PlaygroundGather | null;
  model: PlaygroundModel | null;
  /** The retry's query, when the question missed as asked and the retry confirmed. */
  rewrite: string | null;
  /** The planner's calls, in the order made (agent mode). */
  steps: PlaygroundStep[];
  /** The planner's restatement of a follow-up. */
  resolved: string | null;
  sources: PlaygroundSource[];
  claims: { claim: string; chunkIds: string[] }[];
  outcome: PlaygroundOutcome | null;
  /** Workbench: proposals waiting for the owner, refusals, listings -- all server-written. */
  actions: WorkbenchAction[];
  refused: { tool: string; code: string; message: string }[];
  listings: WorkbenchListingPart[];
  conversationId: string | null;
}

function readTurn(message: PlaygroundUIMessage): Turn {
  const turn: Turn = {
    routing: null,
    gather: null,
    model: null,
    rewrite: null,
    steps: [],
    resolved: null,
    sources: [],
    claims: [],
    outcome: null,
    actions: [],
    refused: [],
    listings: [],
    conversationId: null,
  };
  for (const part of message.parts) {
    if (part.type === 'data-routing') turn.routing = part.data;
    else if (part.type === 'data-gather') turn.gather = part.data;
    else if (part.type === 'data-model') turn.model = part.data;
    else if (part.type === 'data-rewrite') turn.rewrite = part.data.query;
    else if (part.type === 'data-step') turn.steps.push(part.data);
    else if (part.type === 'data-resolved') turn.resolved = part.data.question;
    else if (part.type === 'data-sources') turn.sources = part.data.sources;
    else if (part.type === 'data-claim') turn.claims.push(part.data);
    else if (part.type === 'data-outcome') turn.outcome = part.data.kind;
    else if (part.type === 'data-action') turn.actions.push(part.data);
    else if (part.type === 'data-refused') turn.refused.push(part.data);
    else if (part.type === 'data-listing') turn.listings.push(part.data);
    else if (part.type === 'data-conversation') turn.conversationId = part.data.id;
  }
  return turn;
}

/** How many distinct sources the claims cite -- the head of the numbering. */
function citedCount(turn: Turn): number {
  return new Set(turn.claims.flatMap((claim) => claim.chunkIds)).size;
}

/** Footnote numbers, in order of first citation; uncited sources come after. */
function sourceNumbers(turn: Turn): Map<string, number> {
  const numbers = new Map<string, number>();
  for (const claim of turn.claims) {
    for (const chunkId of claim.chunkIds) {
      if (!numbers.has(chunkId)) numbers.set(chunkId, numbers.size + 1);
    }
  }
  for (const source of turn.sources) {
    if (!numbers.has(source.chunkId)) numbers.set(source.chunkId, numbers.size + 1);
  }
  return numbers;
}

function SourceList({
  sources,
  numbers,
  citedCount,
  t,
}: {
  sources: PlaygroundSource[];
  numbers: Map<string, number>;
  /** How many of `sources` a claim cites; they carry the lowest numbers. */
  citedCount: number;
  t: Dictionary['playground'];
}) {
  /* The library is named on each line only when the answer drew on several. */
  const multiLibrary = new Set(sources.map((source) => source.libraryId)).size > 1;
  const ordered = [...sources].sort(
    (a, b) => (numbers.get(a.chunkId) ?? 99) - (numbers.get(b.chunkId) ?? 99),
  );
  /*
   * A degraded turn cites nothing, and then the passages are the whole
   * answer -- all shown. Otherwise the uncited remainder is retrieval's
   * working set, not evidence, and stays folded behind its count.
   */
  const shown = citedCount > 0 ? ordered.slice(0, citedCount) : ordered;
  const folded = citedCount > 0 ? ordered.slice(citedCount) : [];

  return (
    <div className="mt-3.5 flex flex-col gap-1.5 border-t border-line/60 pt-3">
      <p className="text-[10.5px] font-medium tracking-[0.02em] text-faint uppercase">
        {t.sourcesLabel}
      </p>
      {shown.map((source) => (
        <SourceLine
          key={source.chunkId}
          source={source}
          number={numbers.get(source.chunkId)}
          showLibrary={multiLibrary}
          codeLabel={t.allowance.codeLabel}
        />
      ))}
      {folded.length > 0 ? (
        <details className="group mt-1">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[10.5px] text-faint hover:text-muted">
            <span aria-hidden className="transition-transform group-open:rotate-90">
              ▸
            </span>
            {fill(t.sourcesMore, { count: String(folded.length) })}
          </summary>
          <div className="mt-1.5 flex flex-col gap-1.5">
            {folded.map((source) => (
              <SourceLine
                key={source.chunkId}
                source={source}
                number={numbers.get(source.chunkId)}
                showLibrary={multiLibrary}
                codeLabel={t.allowance.codeLabel}
              />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

/**
 * One source, and the fenced code its passage carried (requirement.md 5.1:
 * the playground shows 代码示例). The code is the chunk's own text, lifted
 * out by the server as data -- shown verbatim, never interpreted, and folded
 * so a long snippet does not crowd the citation it belongs to.
 */
function SourceLine({
  source,
  number,
  showLibrary,
  codeLabel,
}: {
  source: PlaygroundSource;
  number: number | undefined;
  showLibrary: boolean;
  codeLabel: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <p className="flex flex-wrap items-baseline gap-1.5 text-[10.5px] text-muted">
        <span className="rounded bg-cite/12 px-1 font-medium text-cite">{number}</span>
        {showLibrary ? (
          <span
            className="rounded bg-tray px-1 font-mono text-[10px] text-faint"
            title={source.libraryId}
          >
            {source.libraryTitle}
          </span>
        ) : null}
        <a
          href={source.sourceUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="font-medium text-ink underline-offset-2 hover:underline"
        >
          {source.documentTitle}
        </a>
        {source.section ? <span>· {source.section}</span> : null}
      </p>
      {source.codeBlocks.length > 0 ? (
        <details className="group ml-6">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[10.5px] text-faint hover:text-muted">
            <span aria-hidden className="transition-transform group-open:rotate-90">
              ▸
            </span>
            {codeLabel}
            {source.codeBlocks.length > 1 ? ` (${source.codeBlocks.length})` : ''}
          </summary>
          <div className="mt-1.5 flex flex-col gap-1.5">
            {source.codeBlocks.map((block, index) => (
              <pre
                key={index}
                data-lang={block.lang ?? undefined}
                className="overflow-x-auto rounded-md border border-line/70 bg-tray p-2.5 font-mono text-[11px] leading-[1.6] text-ink"
              >
                <code>{block.code}</code>
              </pre>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

/** A turning arrow while the server is routing and retrieving. */
function Pending({ label }: { label: string }) {
  return (
    <p className="flex items-center gap-2 text-[12.5px] text-muted">
      <RotateCwIcon size={14} className="shrink-0 animate-spin text-faint" />
      {label}
    </p>
  );
}

/** What a planner's call was asked, and what it came back with. */
function stepParams(step: PlaygroundStep): (readonly [string, string])[] {
  const params: (readonly [string, string])[] = [];
  if (step.libraryId) params.push(['libraryId', JSON.stringify(step.libraryId)]);
  params.push(['query', JSON.stringify(step.query)]);
  if (step.status === 'running') return params;
  if (step.error) params.push(['error', step.error]);
  else if (step.results) params.push(['results', JSON.stringify(step.results)]);
  else if (step.confirmed !== null) {
    params.push(['confirmed', String(step.confirmed)]);
    if (step.version) params.push(['version', JSON.stringify(step.version)]);
  }
  return params;
}

/** A read tool's result, as the server wrote it (agent-first-proposal.md 5.3). */
function ListingCard({ listing, w }: { listing: WorkbenchListingPart; w: Dictionary['dashboard']['workbench'] }) {
  if (listing.kind === 'subscriptions') {
    return (
      <article className="rounded-md bg-reply p-3.5">
        <p className="text-[12.5px] font-medium text-ink">{w.listingChannels}</p>
        <ul className="mt-1.5 flex flex-col gap-1 text-[12px] text-muted">
          {listing.channels.map((channel) => (
            <li key={channel.slug}>
              <span className="font-mono text-[11px] text-ink">/channels/{channel.slug}</span> · {channel.title} ·{' '}
              {channel.visibility} · {fill(w.assetsCount, { n: String(channel.assets) })}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[11.5px] text-faint">
          {fill(w.listingStorage, { used: formatBytes(listing.usedBytes), capacity: formatBytes(listing.capacityBytes) })}
        </p>
        <p className="mt-1 text-[11.5px] text-faint">{w.listingSubscriptions}</p>
      </article>
    );
  }
  return (
    <article className="rounded-md bg-reply p-3.5">
      <p className="text-[12.5px] font-medium text-ink">{fill(w.listingAssets, { n: String(listing.total) })}</p>
      {listing.assets.length === 0 ? <p className="mt-1.5 text-[12px] text-muted">{w.listingNone}</p> : null}
      <ul className="mt-1.5 flex flex-col gap-1 text-[12px] text-muted">
        {listing.assets.map((asset) => (
          <li key={asset.id}>
            <a href={`/dashboard/assets/${asset.id}`} className="text-ink underline-offset-2 hover:underline">
              {asset.title}
            </a>{' '}
            <span className="font-mono text-[10.5px] text-faint">{asset.publicId}</span> · {asset.kind} ·{' '}
            {asset.channel ? `/channels/${asset.channel}` : w.unfiled}
            {asset.building ? ` · ${w.building}` : ''}
          </li>
        ))}
      </ul>
    </article>
  );
}

function AssistantTurn({
  message,
  streaming,
  t,
}: {
  message: PlaygroundUIMessage;
  streaming: boolean;
  t: Dictionary['playground'];
}) {
  const { t: all } = useI18n();
  const turn = readTurn(message);
  const numbers = sourceNumbers(turn);
  const workbenchShown = turn.actions.length + turn.refused.length + turn.listings.length > 0;

  if (turn.routing === null && turn.steps.length === 0 && turn.outcome === null && !workbenchShown) {
    return (
      <AssistantRow>
        <Pending label={t.resolving} />
      </AssistantRow>
    );
  }

  /*
   * The transcript shows the real calls: one resolve-library-id with what it
   * returned, then one query-docs per candidate -- every candidate is read
   * (scatter-gather, architecture.md 9.6), and the note under them says
   * which ones fit the question well enough to answer.
   */
  const routing = turn.routing;
  const candidates = routing?.candidates ?? [];
  const routingParams: (readonly [string, string])[] = [
    ['query', JSON.stringify(routing?.question ?? '')],
  ];
  if (candidates.length > 0) {
    routingParams.push(['results', JSON.stringify(candidates.map((c) => c.libraryId))]);
  }
  const gathered = turn.gather?.libraries ?? [];
  const answering = gathered.filter((library) => library.confirmed);
  const skipped = gathered.filter((library) => !library.confirmed);
  const named = (library: { title: string; version: string | null }) =>
    library.version ? `${library.title} (${library.version})` : library.title;

  return (
    <AssistantRow>
      {/* A pinned exchange never ran resolve-library-id, so it is not shown
          as if it had: the transcript is the real call sequence. */}
      {routing && !routing.pinned ? (
        <ToolCall name="resolve-library-id" params={routingParams} />
      ) : null}
      {candidates.map((candidate) => (
        <ToolCall
          key={candidate.libraryId}
          name="query-docs"
          params={[
            ['libraryId', JSON.stringify(candidate.libraryId)],
            ['query', JSON.stringify(routing!.question)],
          ]}
        />
      ))}
      {/* Agent mode: the planner's own calls, each shown as it runs. */}
      {turn.steps.map((step) => (
        <ToolCall
          key={step.id}
          name={step.tool}
          running={step.status === 'running'}
          params={stepParams(step)}
        />
      ))}
      {turn.resolved !== null ? (
        <p className="text-[11.5px] leading-[1.7] text-faint">
          {fill(t.resolvedNote, { question: turn.resolved })}
        </p>
      ) : null}
      {/* The retry is a real second read of every candidate, shown as one. */}
      {turn.rewrite !== null
        ? candidates.map((candidate) => (
            <ToolCall
              key={`${candidate.libraryId}-rewrite`}
              name="query-docs"
              params={[
                ['libraryId', JSON.stringify(candidate.libraryId)],
                ['query', JSON.stringify(turn.rewrite)],
              ]}
            />
          ))
        : null}
      {turn.rewrite !== null ? (
        <p className="text-[11.5px] leading-[1.7] text-faint">
          {fill(t.rewriteNote, { query: turn.rewrite })}
        </p>
      ) : null}

      {answering.length > 0 ? (
        <p className="text-[11.5px] leading-[1.7] text-faint">
          {answering.length === 1
            ? fill(t.routedNote, {
                title: answering[0]!.title,
                version: answering[0]!.version ?? '',
              })
            : fill(t.routedNoteMany, { list: answering.map(named).join(', ') })}
          {skipped.length > 0 ? (
            <>
              {' '}
              {fill(t.routedSkipped, {
                list: skipped.map((l) => l.title).join(', '),
              })}
            </>
          ) : null}
        </p>
      ) : null}

      {turn.listings.map((listing, index) => (
        <ListingCard key={`listing-${index}`} listing={listing} w={all.dashboard.workbench} />
      ))}
      {turn.actions.map((action) => (
        <ActionCard key={action.id} action={action} />
      ))}
      {turn.refused.map((refusal, index) => (
        <WarnCard key={`refused-${index}`} title={all.dashboard.workbench.refusedTitle} body={refusal.message} />
      ))}

      {turn.outcome === 'no_library' ? (
        <WarnCard title={t.noLibraryTitle} body={t.noLibraryBody} />
      ) : null}
      {turn.outcome === 'no_context' ? (
        <WarnCard title={t.noContextTitle} body={t.noContextBody} />
      ) : null}

      {turn.outcome === 'degraded' ? (
        <article className="rounded-md rounded-bl-[4px] bg-reply p-3.5">
          <p className="text-[12.5px] font-medium text-ink">{t.degradedTitle}</p>
          <p className="mt-1.5 text-[12px] leading-[1.75] text-muted">{t.degradedBody}</p>
          <SourceList sources={turn.sources} numbers={numbers} citedCount={0} t={t} />
        </article>
      ) : null}

      {turn.claims.length > 0 ? (
        <article className="rounded-md rounded-bl-[4px] bg-reply p-3.5">
          <p className="text-[12.5px] leading-[1.75] whitespace-pre-line text-muted">
            {turn.claims.map((entry, index) => (
              <span key={`${entry.claim}-${index}`}>
                <ClaimText text={entry.claim} />
                {entry.chunkIds.map((chunkId) => (
                  <sup
                    key={chunkId}
                    className="ml-0.5 rounded bg-cite/12 px-1 text-[9px] font-medium text-cite"
                  >
                    {numbers.get(chunkId)}
                  </sup>
                ))}{' '}
              </span>
            ))}
            {streaming ? (
              <span
                aria-hidden
                className="ml-0.5 inline-block h-[1em] w-[2px] animate-pulse bg-brand align-text-bottom"
              />
            ) : null}
          </p>
          {turn.outcome !== null ? (
            <SourceList
              sources={turn.sources}
              numbers={numbers}
              citedCount={citedCount(turn)}
              t={t}
            />
          ) : null}
        </article>
      ) : null}

      {turn.outcome === null && turn.claims.length === 0 && !workbenchShown ? (
        <Pending label={t.thinkingLive} />
      ) : null}
    </AssistantRow>
  );
}

/** The uniform envelope carries a code; anything else is a generic failure. */
/** The error envelope's code, or null for a transport failure or an empty body. */
function errorCode(error: Error | undefined): string | null {
  if (!error) return null;
  try {
    return (JSON.parse(error.message) as { error?: { code?: string } }).error?.code ?? null;
  } catch {
    return null;
  }
}

function errorMessage(error: Error | undefined, t: Dictionary['playground']): string | null {
  if (!error) return null;
  const code = errorCode(error);
  if (code === 'rate_limited' || code === 'quota_exceeded') return t.rateLimited;
  /* The session ended while the page stayed open. */
  if (code === 'access_denied') return t.signInRequired;
  return t.askError;
}

/**
 * Where a question typed before signing in waits out the OAuth round trip.
 * Session storage: the same tab, and gone with it. Every access is guarded --
 * a private window or blocked storage just loses the draft.
 */
const DRAFT_KEY = 're0:playground-draft';

function keepDraft(question: string): void {
  try {
    sessionStorage.setItem(DRAFT_KEY, question);
  } catch {
    /* storage unavailable */
  }
}

function takeDraft(): string | null {
  try {
    const draft = sessionStorage.getItem(DRAFT_KEY);
    sessionStorage.removeItem(DRAFT_KEY);
    return draft;
  } catch {
    return null;
  }
}

export function Playground({
  /**
   * A public Library ID to query instead of auto-routing -- the detail page's
   * "Try in Playground" (`/playground?library=`). Cleared by the visitor
   * from the chip above the composer.
   */
  initialLibrary = null,
  /**
   * Whether a session is behind this render. The page is open to everyone;
   * sending is not (`playgroundCaller`), so a visitor without one is asked to
   * sign in at the moment they send, and their question waits for them.
   */
  signedIn,
  /**
   * `workbench`: the Dashboard conversation (agent-first-proposal.md 4.4,
   * 4.5) -- the same transcript posting to /api/agent, which adds the
   * owner's tools and their confirmation cards. `playground` (default): the
   * public demo; a signed-in visitor's question is taken to the workbench.
   */
  mode = 'playground',
  /** A question to send once on arrival: the one a visitor typed on /playground or the home page. */
  initialQuestion = null,
  /** The conversation to continue; a new one is started by the first question otherwise. */
  conversationId = null,
  /** The conversation so far, rebuilt by the server from what it recorded. */
  initialMessages,
}: {
  initialLibrary?: string | null;
  signedIn: boolean;
  mode?: 'playground' | 'workbench';
  initialQuestion?: string | null;
  conversationId?: string | null;
  initialMessages?: PlaygroundUIMessage[];
}) {
  const { t: messages } = useI18n();
  const t = messages.playground;
  const workbenchWords = messages.dashboard.workbench;
  const isWorkbench = mode === 'workbench';
  const router = useRouter();
  const conversation = useRef<string | null>(conversationId);
  const [question, setQuestion] = useState('');
  const [pinnedLibrary, setPinnedLibrary] = useState<string | null>(initialLibrary);
  const pinned = useRef<string | null>(initialLibrary);
  useEffect(() => {
    pinned.current = pinnedLibrary;
  }, [pinnedLibrary]);
  const transport = useMemo(() => playgroundTransport(pinned, isWorkbench ? conversation : null), [isWorkbench]);
  const scroller = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const [signingIn, setSigningIn] = useState(false);

  /* Back from signing in: the question asked before it is in the composer, ready to send. */
  useEffect(() => {
    if (!signedIn) return;
    const draft = takeDraft();
    if (!draft) return;
    setQuestion(draft);
    composer.current?.focus();
  }, [signedIn]);

  const {
    messages: turns,
    sendMessage,
    status,
    stop,
    error,
  } = useChat<PlaygroundUIMessage>({
    transport,
    ...(initialMessages && initialMessages.length > 0 ? { messages: initialMessages } : {}),
  });

  const busy = status === 'submitted' || status === 'streaming';

  /* The conversation the server recorded this exchange in; the next question continues it. */
  useEffect(() => {
    if (!isWorkbench) return;
    for (const message of turns) {
      const id = readTurn(message).conversationId;
      if (id) conversation.current = id;
    }
  }, [turns, isWorkbench]);

  /* A question carried in from elsewhere is sent once, on arrival. */
  const sentInitial = useRef(false);
  useEffect(() => {
    if (!isWorkbench || !initialQuestion || sentInitial.current) return;
    sentInitial.current = true;
    void sendMessage({ text: initialQuestion });
  }, [isWorkbench, initialQuestion, sendMessage]);

  /*
   * Follow the stream, but only for a reader who is already at the bottom --
   * yanking the viewport back while someone is reading an earlier citation is
   * the one thing a growing transcript must not do.
   */
  useEffect(() => {
    const box = scroller.current;
    if (!box) return;
    const distance = box.scrollHeight - box.scrollTop - box.clientHeight;
    if (distance < 160) box.scrollTo({ top: box.scrollHeight });
  }, [turns, status]);

  /* A session that ended while the page stayed open is asked for again, the same way. */
  const lastAsked = useRef('');
  const sessionEnded = errorCode(error) === 'access_denied';
  useEffect(() => {
    if (!sessionEnded) return;
    if (lastAsked.current) keepDraft(lastAsked.current);
    setSigningIn(true);
  }, [sessionEnded]);

  function submit(text: string) {
    const asked = text.trim();
    if (!asked || busy) return;
    if (!signedIn) {
      keepDraft(asked);
      setSigningIn(true);
      return;
    }
    /*
     * agent-first-proposal.md 4.5: the public playground is a demo; a
     * signed-in visitor's question goes to their workbench conversation. A
     * question pinned to one public asset (the detail page's entry) stays.
     */
    if (!isWorkbench && !pinned.current) {
      router.push(`/dashboard?q=${encodeURIComponent(asked.slice(0, 2_000))}`);
      return;
    }
    lastAsked.current = asked;
    setQuestion('');
    void sendMessage({ text: asked });
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    submit(question);
  }

  /* Enter sends, Shift+Enter breaks the line -- the convention every chat has. */
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit(question);
  }

  const failure = errorMessage(error, t);

  return (
    <div className="mx-auto w-full">
      <div className="flex h-[640px] max-h-[78vh] flex-col overflow-hidden rounded-lg border border-line bg-card">
        <div ref={scroller} className="flex-1 overflow-y-auto">
          <div className="flex min-h-full flex-col gap-5 p-4">
            {/* The empty transcript is where the suggestions belong: centred
                in the space they are about to fill, rather than crowding the
                composer for the one moment before the first question. */}
            {turns.length === 0 && !failure ? (
              <div className="m-auto flex w-full max-w-[560px] flex-col items-center gap-3 py-8">
                {/* Decorative: the page's own h1 (app/(public)/playground) names it for assistive technology. */}
                <p
                  aria-hidden
                  className="mb-3 text-center text-[26px] leading-[1.35] font-medium text-ink sm:text-[30px]"
                >
                  {isWorkbench ? workbenchWords.title : t.title}
                </p>
                {(isWorkbench ? workbenchWords.suggestions : t.suggestions).map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    onClick={() => submit(suggestion)}
                    className="w-full max-w-[380px] rounded-md border border-line bg-subtle px-4 py-2.5 text-[12.5px] text-muted transition-colors hover:border-brand/50 hover:bg-tray hover:text-ink"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            ) : null}

            {turns.map((message) =>
              message.role === 'user' ? (
                <UserBubble
                  key={message.id}
                  text={message.parts
                    .filter((part) => part.type === 'text')
                    .map((part) => part.text)
                    .join(' ')}
                />
              ) : (
                <AssistantTurn
                  key={message.id}
                  message={message}
                  streaming={status === 'streaming' && message === turns[turns.length - 1]}
                  t={t}
                />
              ),
            )}

            {/* The assistant message does not exist until the first part
                arrives; until then the sent question would sit unanswered
                with no sign anything was happening. */}
            {busy && turns[turns.length - 1]?.role === 'user' ? (
              <AssistantRow>
                <Pending label={t.resolving} />
              </AssistantRow>
            ) : null}

            {failure ? <WarnCard title={t.askErrorTitle} body={failure} /> : null}
          </div>
        </div>

        <form onSubmit={onSubmit} className="p-3.5">
          {pinnedLibrary ? (
            <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-muted">
              <span className="rounded-full bg-brandsoft px-2.5 py-0.5 font-mono text-[10.5px] font-medium text-brandink">
                {fill(t.allowance.pinnedTo, { library: pinnedLibrary })}
              </span>
              <button
                type="button"
                onClick={() => setPinnedLibrary(null)}
                className="text-[11px] text-faint underline-offset-2 hover:text-ink hover:underline"
              >
                {t.allowance.unpin}
              </button>
            </div>
          ) : null}
          <div className="relative rounded-md border border-line bg-field transition-colors focus-within:border-brand">
            <textarea
              ref={composer}
              rows={1}
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder={isWorkbench ? workbenchWords.inputPlaceholder : t.inputPlaceholder}
              aria-label={isWorkbench ? workbenchWords.inputPlaceholder : t.inputPlaceholder}
              className="block max-h-[160px] min-h-[46px] w-full resize-none bg-transparent px-3.5 py-3 pr-[52px] text-[13px] leading-[1.5] text-ink outline-none placeholder:text-muted/70"
            />
            {busy ? (
              <button
                type="button"
                onClick={stop}
                aria-label={t.stop}
                className="absolute right-2 bottom-2 flex size-8 items-center justify-center rounded-full bg-ink text-card transition-opacity hover:opacity-90"
              >
                <span aria-hidden className="size-2.5 rounded-[2px] bg-card" />
              </button>
            ) : (
              <button
                type="submit"
                disabled={question.trim().length === 0}
                aria-label={t.send}
                className="absolute right-2 bottom-2 flex size-8 items-center justify-center rounded-full bg-brand text-onbrand transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                <svg
                  aria-hidden
                  viewBox="0 0 24 24"
                  width={15}
                  height={15}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 19V5" />
                  <path d="m5 12 7-7 7 7" />
                </svg>
              </button>
            )}
          </div>
        </form>
      </div>

      <p className="mt-3.5 text-center text-[11.5px] leading-[1.7] text-faint">
        {t.footnoteLine1}
        <br />
        {t.footnoteLine2}
      </p>

      {signingIn ? (
        <SignInDialog
          returnTo={
            pinnedLibrary ? `/playground?library=${encodeURIComponent(pinnedLibrary)}` : '/playground'
          }
          title={t.signInTitle}
          subtitle={t.signInSubtitle}
          closeLabel={t.signInClose}
          onClose={() => setSigningIn(false)}
        />
      ) : null}
    </div>
  );
}
