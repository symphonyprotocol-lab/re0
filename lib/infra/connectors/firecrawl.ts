/**
 * Uploaded PDFs the local parser cannot read (./pdf.ts), through Firecrawl's
 * /v2/parse endpoint. Send bytes, not a public Blob URL. Pages keep their
 * physical page numbers all the way through chunking and citation snapshots.
 */
import { z } from 'zod';
import type { Section } from '@/lib/domain/knowledge';
import { ProcessingFailure } from './failure';
import { rotatesFirecrawlKey } from '@/lib/domain/firecrawl';
import { claimFirecrawlKey, recordFirecrawlKeyResult, type FirecrawlCredential } from '@/lib/infra/firecrawl/keys';
import { prepareProviderCall } from '@/lib/infra/ai/provider-meter';
import { ProviderCostUnavailable } from '@/lib/domain/provider-cost';
import { InsufficientCredits } from '@/lib/domain/credits';

/** Used when the caller gives no deadline. */
const TIMEOUT_MS = 120_000;
const DEFAULT_BASE_URL = 'https://api.firecrawl.dev';

const parsedDocument = z.object({
  success: z.literal(true),
  data: z.object({
    pages: z.array(z.object({ pageNumber: z.number().int().positive(), markdown: z.string() })).optional(),
    metadata: z.object({
      numPages: z.number().int().nonnegative().optional(),
      totalPages: z.number().int().nonnegative().optional(),
      creditsUsed: z.number().finite().nonnegative().optional(),
    }).optional(),
  }),
});

/**
 * `deadline` (epoch ms) bounds the whole call, key rotation included.
 * `pages`, the page count when the PDF could be opened locally, is reserved
 * at Firecrawl's 1 credit per page before the file is sent.
 */
export async function firecrawlSections(bytes: Uint8Array, fileName: string, { deadline = Date.now() + TIMEOUT_MS, pages: knownPages }: { deadline?: number; pages?: number } = {}): Promise<Section[]> {
  const customBase = process.env.FIRECRAWL_BASE_URL?.trim();
  const attempted: string[] = [];
  let lastFailure: ProcessingFailure | null = null;

  const form = new FormData();
  form.set('file', new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }), fileName);
  form.set('options', JSON.stringify({
    formats: ['markdown'],
    onlyMainContent: false,
    // Firecrawl's own limit; our request is aborted at the same deadline.
    timeout: Math.max(1, Math.floor(deadline - Date.now())),
    parsers: [{ type: 'pdf', mode: 'auto', pages: true }],
  }));

  let data: z.infer<typeof parsedDocument>['data'];
  for (;;) {
    const claim = await claimFirecrawlKey([...attempted]);
    let credential: FirecrawlCredential;
    if (claim.managed) {
      if (!claim.credential) throw lastFailure ?? new ProcessingFailure('parse_failed', 'No enabled Firecrawl key is available; check console configuration or cooldowns');
      credential = claim.credential;
      attempted.push(credential.id!);
    } else {
      if (attempted.length) throw lastFailure ?? new ProcessingFailure('parse_failed', 'The Firecrawl key pool changed during parsing');
      const apiKey = process.env.FIRECRAWL_API_KEY?.trim() || null;
      if (!apiKey && !customBase) throw new ProcessingFailure('parse_failed', 'Firecrawl document parsing is not configured: add keys in the console or set FIRECRAWL_API_KEY');
      credential = { id: null, apiKey };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw lastFailure ?? new ProcessingFailure('parse_failed', 'Firecrawl document parsing timed out');
    // Once Firecrawl has answered, the key worked: later failures are ours, not the key's.
    let answered = false;
    let call: Awaited<ReturnType<typeof prepareProviderCall>> = null;
    try {
      call = await prepareProviderCall(
        { service: 'firecrawl', endpoint: (customBase || DEFAULT_BASE_URL).replace(/\/+$/, ''), model: 'parse', account: credential.id ?? 'environment' },
        knownPages ? { estimate: { firecrawlCredits: knownPages } } : {},
      );
      const response = await fetch(`${(customBase || DEFAULT_BASE_URL).replace(/\/+$/, '')}/v2/parse`, {
        method: 'POST',
        headers: credential.apiKey ? { Authorization: `Bearer ${credential.apiKey}` } : {},
        body: form,
        signal: AbortSignal.timeout(remaining),
        cache: 'no-store',
        redirect: 'error',
      });
      answered = true;
      await recordFirecrawlKeyResult(credential, response.status, response.headers.get('retry-after'));
      if (!response.ok) {
        const code = response.status === 429 ? 'rate_limited' : response.status === 413 ? 'source_too_large' : 'parse_failed';
        lastFailure = new ProcessingFailure(code, `Firecrawl document parsing returned HTTP ${response.status}`);
        if (credential.id && rotatesFirecrawlKey(response.status)) continue;
        throw lastFailure;
      }
      const requestId = response.headers.get('x-request-id') ?? undefined;
      const raw: unknown = await response.json().catch(() => null);
      if (raw === null) {
        // Billed but unreadable: keep the receipt unresolved for reconciliation, then fail the parse.
        await call?.complete({ usage: {}, requestId, acceptUnknownCost: true });
        throw new ProcessingFailure('parse_failed', 'Firecrawl returned an invalid document response');
      }
      const reply = (raw as { data?: { pages?: unknown; metadata?: { creditsUsed?: number; numPages?: number; totalPages?: number } } }).data;
      const metadata = reply?.metadata;
      /*
       * PDF parsing is documented at 1 credit per page. Without `creditsUsed`,
       * the largest page count any part of the reply (or our own reading) gives
       * is billed, so a truncated reply is never billed for fewer pages.
       */
      const pageCounts = [metadata?.numPages, metadata?.totalPages, Array.isArray(reply?.pages) ? reply.pages.length : undefined, knownPages]
        .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0);
      const firecrawlCredits = typeof metadata?.creditsUsed === 'number' ? metadata.creditsUsed : pageCounts.length > 0 ? Math.max(...pageCounts) : undefined;
      await call?.complete({ usage: { firecrawlCredits }, requestId });
      const parsed = parsedDocument.safeParse(raw);
      if (!parsed.success) throw new ProcessingFailure('parse_failed', 'Firecrawl returned an invalid document response');
      data = parsed.data.data;
      break;
    } catch (error) {
      if (error instanceof ProcessingFailure || error instanceof ProviderCostUnavailable || error instanceof InsufficientCredits) throw error;
      if (!answered) await recordFirecrawlKeyResult(credential, 0);
      // Provider errors may contain credentials or document text; keep them out of logs.
      throw new ProcessingFailure('parse_failed', 'Firecrawl document parsing request failed or timed out');
    } finally {
      // A rotated key's request is answered or abandoned: its page estimate leaves the in-flight sum.
      call?.release();
    }
  }

  const { numPages, totalPages } = data.metadata ?? {};
  if (numPages !== undefined && totalPages !== undefined && numPages < totalPages) {
    throw new ProcessingFailure('parse_failed', 'Firecrawl returned a truncated document');
  }

  // Never fall back to document-level markdown: its page attribution is lost.
  if (!data.pages) throw new ProcessingFailure('parse_failed', 'Firecrawl did not return physical PDF pages');
  const pages = [...data.pages].sort((a, b) => a.pageNumber - b.pageNumber);
  if (new Set(pages.map((page) => page.pageNumber)).size !== pages.length) {
    throw new ProcessingFailure('parse_failed', 'Firecrawl returned duplicate PDF page numbers');
  }
  const expectedPages = totalPages ?? numPages;
  if (expectedPages !== undefined && (pages.length !== expectedPages || pages.some((page) => page.pageNumber > expectedPages))) {
    throw new ProcessingFailure('parse_failed', 'Firecrawl returned incomplete PDF page data');
  }
  // Filter blank pages only after assigning their original numbers.
  const sections: Section[] = pages
    .map((page) => ({ text: page.markdown.trim(), locator: { page: page.pageNumber } }))
    .filter((section) => section.text.length > 0);
  if (sections.length === 0) throw new ProcessingFailure('empty_text', 'Firecrawl extracted no document text');
  return sections;
}
