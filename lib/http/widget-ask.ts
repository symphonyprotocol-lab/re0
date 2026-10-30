/**
 * One visitor question, answered as a newline-delimited JSON stream: the
 * body of `POST /api/embed/ask`, shared with the showcase page's own ask
 * route (`POST /api/showcase/ask`). requirement.md 9.4, lib/application/embed.
 *
 * The two routes differ only in who the caller is allowed to be -- a parent
 * page on the key's allowlist, or the page this deployment serves -- and
 * both hand the admitted question here. Generation is the playground's
 * (architecture.md 9.5): the same retrieval, the same binding of every
 * sentence to a retrieved passage, and the same degradation to the passage
 * list when no model is configured.
 *
 * Order matters for what gets charged: an asset that cannot answer yet is
 * told so before the limiters run, so retries against a building asset do
 * not spend the owner's day; the limiters run before retrieval, which is the
 * only place they can stand in front of it.
 */
import type { NextRequest } from 'next/server';
import { AppError } from '@/contracts/errors';
import {
  admitWidgetQuestion,
  noteWidgetExchange,
  noteWidgetOrigin,
  recordWidgetExchange,
  widgetCaller,
  type SiteKeyPrincipal,
  type WidgetOutcome,
} from '@/lib/application/embed';
import { streamPlayground } from '@/lib/application/playground';
import type { HistoryTurn } from '@/lib/domain/generation';
import { pagesOf, type WidgetSource } from '@/lib/domain/widget';

/**
 * One line of the stream. The widget page (public/embed-app.js) and the
 * showcase page's chat read these.
 *
 * `outcome.kind` is what the visitor is told at the end: the playground's
 * three, plus `not_ready` (the asset has no published version) and
 * `unavailable` (the exchange was refused after the stream opened -- the
 * workspace's quota is spent, or the asset was suspended meanwhile).
 * `exchange` names the log row, so a page that lets the visitor rate the
 * answer can say which one.
 */
export type WidgetStreamLine =
  | { type: 'exchange'; id: string }
  | { type: 'allowance'; remaining: number; limit: number }
  | {
      type: 'sources';
      /** One entry per page, in the order retrieval ranked its first passage. */
      sources: WidgetSource[];
    }
  | { type: 'claim'; text: string; chunkIds: string[] }
  /** The question missed and was searched again as `query`; the sources are that search's. */
  | { type: 'rewrite'; query: string }
  | {
      type: 'outcome';
      kind: 'answer' | 'no_context' | 'degraded' | 'not_ready' | 'unavailable';
    };

/** Refusals retrieval can raise once the stream is open, and what each means to a visitor. */
const UNAVAILABLE_CODES = new Set<string>([
  'quota_exceeded',
  'subscription_required',
  'library_not_ready',
  'library_suspended',
  'library_not_found',
  'access_rule_blocked',
  'access_denied',
]);

export function ndjson(lines: (write: (line: WidgetStreamLine) => void) => Promise<void>, requestId: string): Response {
  const encoder = new TextEncoder();
  let open = true;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      /* A visitor who closes the widget mid-answer cancels the stream; a
         write after that must not turn a routine abort into an error. */
      const write = (line: WidgetStreamLine) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
        } catch {
          open = false;
        }
      };
      try {
        await lines(write);
      } finally {
        if (open) {
          open = false;
          controller.close();
        }
      }
    },
    cancel() {
      open = false;
    },
  });
  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'private, no-store',
      'x-re0-request-id': requestId,
    },
  });
}

export interface WidgetAskInput {
  request: NextRequest;
  principal: SiteKeyPrincipal;
  question: string;
  /** The embedding page's origin, as logged; null for a page of ours. */
  parent: string | null;
  /** The owner's try-out from the dashboard: metered, logged as a preview, no origin mark. */
  preview: boolean;
  /** Whether an admitted question marks `parent` as an integrated site. */
  markOrigin: boolean;
  requestId: string;
  startedAt: number;
  /** The log row's id, when the caller needs to name it; minted by the log otherwise. */
  exchangeId?: string;
  /** Lines written before anything else, once the stream is open. */
  preface?: WidgetStreamLine[];
  /** Runs once the question is admitted and about to be charged. */
  onAdmitted?: () => void;
  /** The turns before this question, already normalised (lib/domain/generation.ts `normaliseHistory`). */
  history?: readonly HistoryTurn[];
}

/** The question is already validated (1 to 2000 characters) and the caller allowed. */
export async function streamWidgetAnswer(input: WidgetAskInput): Promise<Response> {
  const { request, principal, question, parent, preview, requestId, startedAt } = input;

  /*
   * The owner's history of what the widget was asked (exchanges.ts):
   * written once the exchange has ended, whatever ended it. Off the request
   * path for the widget; awaited -- after the outcome line, before the
   * stream closes -- when the caller named the row, since a page that lets
   * the visitor rate the answer must find the row when the vote arrives.
   */
  const record = async (
    outcome: WidgetOutcome,
    detail: { rewrittenQuery?: string | null; answer?: string | null; sources?: WidgetSource[] } = {},
  ): Promise<void> => {
    const entry = {
      id: input.exchangeId,
      assetId: principal.assetId,
      workspaceId: principal.workspaceId,
      siteKeyId: principal.siteKeyId,
      origin: parent,
      preview,
      question,
      rewrittenQuery: detail.rewrittenQuery ?? null,
      outcome,
      answer: detail.answer ?? null,
      sources: (detail.sources ?? []).map((source) => ({ url: source.url, title: source.title })),
      latencyMs: Date.now() - startedAt,
    };
    if (!input.exchangeId) {
      noteWidgetExchange(entry);
      return;
    }
    await recordWidgetExchange(entry).catch((error: unknown) => {
      console.error(`widget exchange not recorded: ${error instanceof Error ? error.message : 'unknown'}`);
    });
  };

  const preface = input.preface ?? [];

  /* Nothing to retrieve from yet: say so without touching the limiters. */
  if (!principal.ready) {
    return ndjson(async (write) => {
      for (const line of preface) write(line);
      write({ type: 'outcome', kind: 'not_ready' });
      await record('not_ready');
    }, requestId);
  }

  const allowance = await admitWidgetQuestion(request, principal);
  /* Admitted, so it will be answered and charged: count it against the
     site -- unless the site is the owner's own dashboard. */
  if (input.markOrigin && !preview) noteWidgetOrigin(principal.siteKeyId, parent, 'question');
  input.onAdmitted?.();
  const caller = widgetCaller(principal, requestId);

  return ndjson(async (write) => {
    for (const line of preface) write(line);
    write({ type: 'allowance', remaining: allowance.remaining, limit: allowance.limit });
    let sources: WidgetSource[] = [];
    let rewrittenQuery: string | null = null;
    const claims: string[] = [];
    try {
      for await (const event of streamPlayground(caller, {
        assets: [{ assetId: principal.assetPublicId, title: principal.assetTitle }],
        question,
        history: input.history,
      })) {
        if (event.type === 'context') {
          sources = pagesOf(event.chunks);
          write({ type: 'sources', sources });
        } else if (event.type === 'claim') {
          claims.push(event.claim);
          write({ type: 'claim', text: event.claim, chunkIds: event.chunkIds });
        } else if (event.type === 'rewrite') {
          rewrittenQuery = event.query;
          write({ type: 'rewrite', query: event.query });
        } else if (event.type === 'done') {
          write({ type: 'outcome', kind: event.kind });
          await record(event.kind, { rewrittenQuery, sources, answer: claims.length > 0 ? claims.join(' ') : null });
        }
      }
    } catch (error) {
      /*
       * The stream is open, so this is the only place left to say so. A
       * refusal retrieval itself raised -- the workspace out of Calls, the
       * asset suspended since the key was resolved -- is told as
       * `unavailable`, which the widget words honestly; anything else is a
       * fault, logged, and degrades to whatever passages arrived.
       */
      const refused = error instanceof AppError && UNAVAILABLE_CODES.has(error.code);
      if (!refused) {
        console.error(
          `widget stream failed requestId=${requestId}: ${error instanceof Error ? error.message : 'unknown'}`,
        );
      }
      write({ type: 'outcome', kind: refused ? 'unavailable' : 'degraded' });
      await record(refused ? 'unavailable' : 'degraded', { rewrittenQuery, sources, answer: claims.length > 0 ? claims.join(' ') : null });
    }
  }, requestId);
}

/** The question as a body posts it: trimmed, 1 to 2000 characters, else `invalid_request`. */
export function readQuestion(value: unknown): string {
  const question = typeof value === 'string' ? value.trim() : '';
  if (question.length === 0 || question.length > 2_000) {
    throw new AppError('invalid_request', 'question is required (1-2000 characters)');
  }
  return question;
}

/** Whether a browser `Origin` header is this deployment: the configured base URL or the one the request arrived on. */
export function isOwnOrigin(origin: string | null, request: NextRequest, configured: string | null): boolean {
  if (!origin) return false;
  const own = [configured?.toLowerCase().replace(/\/+$/, ''), new URL(request.url).origin.toLowerCase()];
  return own.includes(origin.toLowerCase());
}

/** A showcase route's caller: this deployment, or the page's own live host. */
export function isShowcaseOrigin(origin: string | null, request: NextRequest, configured: string | null, customHost: string | null): boolean {
  if (!origin) return true;
  if (isOwnOrigin(origin, request, configured)) return true;
  return customHost !== null && origin.toLowerCase() === `https://${customHost}`;
}
