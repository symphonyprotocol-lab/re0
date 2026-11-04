/**
 * Uploaded PDF and Word documents through Firecrawl's /v2/parse endpoint.
 * Send bytes, not a public Blob URL. PDF pages keep their physical page
 * numbers all the way through chunking and citation snapshots.
 */
import { z } from 'zod';
import type { Section } from '@/lib/domain/knowledge';
import { ProcessingFailure } from './failure';
import { rotatesFirecrawlKey } from '@/lib/domain/firecrawl';
import { claimFirecrawlKey, recordFirecrawlKeyResult, type FirecrawlCredential } from '@/lib/infra/firecrawl/keys';
import { prepareProviderCall } from '@/lib/infra/ai/provider-meter';
import { ProviderCostUnavailable } from '@/lib/domain/provider-cost';
import { InsufficientCredits } from '@/lib/domain/credits';

const TIMEOUT_MS = 120_000;
const DEFAULT_BASE_URL = 'https://api.firecrawl.dev';

const parsedDocument = z.object({
  success: z.literal(true),
  data: z.object({
    markdown: z.string().optional(),
    pages: z.array(z.object({ pageNumber: z.number().int().positive(), markdown: z.string() })).optional(),
    metadata: z.object({
      numPages: z.number().int().nonnegative().optional(),
      totalPages: z.number().int().nonnegative().optional(),
      creditsUsed: z.number().finite().nonnegative().optional(),
    }).optional(),
  }),
});

export async function firecrawlSections(bytes: Uint8Array, fileName: string, format: 'pdf' | 'docx'): Promise<Section[]> {
  const customBase = process.env.FIRECRAWL_BASE_URL?.trim();
  const deadline = Date.now() + TIMEOUT_MS;
  const attempted: string[] = [];
  let lastFailure: ProcessingFailure | null = null;

  const form = new FormData();
  const contentType = format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  form.set('file', new Blob([new Uint8Array(bytes)], { type: contentType }), fileName);
  form.set('options', JSON.stringify({
    formats: ['markdown'],
    onlyMainContent: false,
    timeout: TIMEOUT_MS,
    ...(format === 'pdf' ? { parsers: [{ type: 'pdf', mode: 'auto', pages: true }] } : {}),
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
    try {
      const call = await prepareProviderCall({ service: 'firecrawl', endpoint: (customBase || DEFAULT_BASE_URL).replace(/\/+$/, ''), model: 'parse', account: credential.id ?? 'environment' });
      const response = await fetch(`${(customBase || DEFAULT_BASE_URL).replace(/\/+$/, '')}/v2/parse`, {
        method: 'POST',
        headers: credential.apiKey ? { Authorization: `Bearer ${credential.apiKey}` } : {},
        body: form,
        signal: AbortSignal.timeout(remaining),
        cache: 'no-store',
        redirect: 'error',
      });
      await recordFirecrawlKeyResult(credential, response.status, response.headers.get('retry-after'));
      if (!response.ok) {
        const code = response.status === 429 ? 'rate_limited' : response.status === 413 ? 'source_too_large' : 'parse_failed';
        lastFailure = new ProcessingFailure(code, `Firecrawl document parsing returned HTTP ${response.status}`);
        if (credential.id && rotatesFirecrawlKey(response.status)) continue;
        throw lastFailure;
      }
      const raw = await response.json();
      const metadata = (raw as { data?: { metadata?: { creditsUsed?: number; numPages?: number } } }).data?.metadata;
      await call?.complete({ usage: { firecrawlCredits: metadata?.creditsUsed ?? (format === 'pdf' ? metadata?.numPages : undefined) }, requestId: response.headers.get('x-request-id') ?? undefined });
      const parsed = parsedDocument.safeParse(raw);
      if (!parsed.success) throw new ProcessingFailure('parse_failed', 'Firecrawl returned an invalid document response');
      data = parsed.data.data;
      break;
    } catch (error) {
      if (error instanceof ProcessingFailure || error instanceof ProviderCostUnavailable || error instanceof InsufficientCredits) throw error;
      await recordFirecrawlKeyResult(credential, 0);
      // Provider errors may contain credentials or document text; keep them out of logs.
      throw new ProcessingFailure('parse_failed', 'Firecrawl document parsing request failed or timed out');
    }
  }

  const { numPages, totalPages } = data.metadata ?? {};
  if (numPages !== undefined && totalPages !== undefined && numPages < totalPages) {
    throw new ProcessingFailure('parse_failed', 'Firecrawl returned a truncated document');
  }

  let sections: Section[];
  if (format === 'pdf') {
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
    sections = pages.map((page) => ({ text: page.markdown.trim(), locator: { page: page.pageNumber } }));
  } else {
    if (data.markdown === undefined) throw new ProcessingFailure('parse_failed', 'Firecrawl did not return Word document markdown');
    sections = [{ text: data.markdown.trim(), locator: {} }];
  }
  // Filter blank pages only after assigning their original numbers.
  sections = sections.filter((section) => section.text.length > 0);
  if (sections.length === 0) throw new ProcessingFailure('empty_text', 'Firecrawl extracted no document text');
  return sections;
}
