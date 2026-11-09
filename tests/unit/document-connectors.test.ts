import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chunkSections } from '@/lib/domain/knowledge';
import { citationSnapshots, locatorLabel } from '@/lib/domain/answer';
import { documentSections } from '@/lib/infra/connectors';
import { firecrawlSections } from '@/lib/infra/connectors/firecrawl';
import { pdfTextLayer } from '@/lib/infra/connectors/pdf';
import { claimFirecrawlKey, recordFirecrawlKeyResult } from '@/lib/infra/firecrawl/keys';
import { withProviderMeter } from '@/lib/infra/ai/provider-meter';
import { providerRateSchema, type ProviderCharge } from '@/lib/domain/provider-cost';
import { InsufficientCredits } from '@/lib/domain/credits';
import { buildPdf, draw, makePdf } from '../fixtures/pdf';
import { deflatedZip, makeDocx, makeZip, word } from '../fixtures/docx';

vi.mock('@/lib/infra/firecrawl/keys', () => ({ claimFirecrawlKey: vi.fn(), recordFirecrawlKeyResult: vi.fn() }));

/** `%PDF` and nothing else: pdf.js cannot open it, so it goes to Firecrawl. */
const bytes = new Uint8Array([37, 80, 68, 70]);
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubEnv('FIRECRAWL_API_KEY', 'fc-test-key');
  vi.stubEnv('FIRECRAWL_BASE_URL', '');
  fetchMock.mockReset();
  vi.mocked(claimFirecrawlKey).mockReset().mockResolvedValue({ managed: false, credential: null });
  vi.mocked(recordFirecrawlKeyResult).mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function reply(data: unknown) {
  fetchMock.mockResolvedValueOnce(Response.json({ success: true, data }));
}

describe('Firecrawl document ingestion (PDFs the local parser hands over)', () => {
  it('switches to the next console key after a rate limit, without using the environment key', async () => {
    vi.mocked(claimFirecrawlKey)
      .mockResolvedValueOnce({ managed: true, credential: { id: 'first', apiKey: 'fc-console-first' } })
      .mockResolvedValueOnce({ managed: true, credential: { id: 'second', apiKey: 'fc-console-second' } });
    fetchMock.mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '90' } }));
    reply({ pages: [{ pageNumber: 7, markdown: 'Warranty policy.' }] });
    expect(await documentSections(bytes, 'document.pdf')).toEqual([{ text: 'Warranty policy.', locator: { page: 7 } }]);
    expect(fetchMock.mock.calls.map((call) => new Headers(call[1]!.headers).get('authorization'))).toEqual(['Bearer fc-console-first', 'Bearer fc-console-second']);
    expect(claimFirecrawlKey).toHaveBeenLastCalledWith(['first']);
    expect(recordFirecrawlKeyResult).toHaveBeenCalledWith({ id: 'first', apiKey: 'fc-console-first' }, 429, '90');
  });

  it('does not use environment fallback when console keys are paused or cooling down', async () => {
    vi.mocked(claimFirecrawlKey).mockResolvedValue({ managed: true, credential: null });
    await expect(documentSections(bytes, 'document.pdf')).rejects.toMatchObject({ code: 'parse_failed' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stops after each console key fails once', async () => {
    vi.mocked(claimFirecrawlKey)
      .mockResolvedValueOnce({ managed: true, credential: { id: 'first', apiKey: 'fc-console-first' } })
      .mockResolvedValueOnce({ managed: true, credential: null });
    fetchMock.mockResolvedValueOnce(new Response('', { status: 402 }));
    await expect(documentSections(bytes, 'document.pdf')).rejects.toMatchObject({ code: 'parse_failed', message: 'Firecrawl document parsing returned HTTP 402' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uploads PDF bytes and keeps physical page numbers through chunking and citations, including after blank pages', async () => {
    reply({
      markdown: 'Whole-document text must not replace page-specific content.',
      pages: [
        { pageNumber: 3, markdown: '## 保修\n\n设备保修两年。' },
        { pageNumber: 2, markdown: '  ' },
        { pageNumber: 1, markdown: '# 产品手册\n\n使用前阅读。' },
      ],
      metadata: { numPages: 3, totalPages: 3 },
    });
    const sections = await documentSections(bytes, '产品手册.PDF');
    expect(sections.map((section) => section.locator.page)).toEqual([1, 3]);
    expect(sections[1]!.text).toContain('设备保修两年');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.firecrawl.dev/v2/parse');
    expect(init).toMatchObject({ method: 'POST', cache: 'no-store', redirect: 'error' });
    expect(new Headers(init!.headers).get('authorization')).toBe('Bearer fc-test-key');
    expect(new Headers(init!.headers).has('content-type')).toBe(false); // fetch supplies the multipart boundary
    const form = init!.body as FormData;
    const file = form.get('file') as File;
    expect(file.name).toBe('产品手册.PDF');
    expect(file.type).toBe('application/pdf');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
    const options = JSON.parse(form.get('options') as string);
    expect(options).toMatchObject({ formats: ['markdown'], onlyMainContent: false, parsers: [{ type: 'pdf', mode: 'auto', pages: true }] });
    // What is left of the document's 120 s once the local reader gave up.
    expect(options.timeout).toBeGreaterThan(100_000);
    expect(options.timeout).toBeLessThanOrEqual(120_000);

    const chunk = chunkSections(sections).find((chunk) => chunk.content.includes('设备保修两年'))!;
    const citations = citationSnapshots('设备保修两年。[1]', [{
      ...chunk, chunkId: 'chunk', knowledgeId: 'source', title: '产品手册', kind: 'document', similarity: 1,
    }]);
    expect(citations[0]!.locator).toMatchObject({ page: 3, heading: '保修' });
    expect(locatorLabel(citations[0]!.locator, 'zh')).toContain('第 3 页');
  });

  it('supports a self-hosted Parse server with an optional key', async () => {
    vi.stubEnv('FIRECRAWL_BASE_URL', 'http://localhost:3002/');
    vi.stubEnv('FIRECRAWL_API_KEY', '');
    reply({ pages: [{ pageNumber: 1, markdown: 'Self-hosted document.' }] });
    await documentSections(bytes, 'notes.pdf');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:3002/v2/parse');
    expect(new Headers(init!.headers).has('authorization')).toBe(false);
  });

  it('uploads only the document slice when passed a Node Buffer backed by a larger allocation', async () => {
    const allocation = Buffer.from('prefix-PDF-suffix');
    const document = allocation.subarray(7, 10);
    reply({ pages: [{ pageNumber: 1, markdown: 'PDF content' }] });
    await documentSections(document, 'slice.pdf');
    const form = fetchMock.mock.calls[0]![1]!.body as FormData;
    expect(await (form.get('file') as File).text()).toBe('PDF');
  });

  it('refuses an unreadable PDF when Firecrawl is not configured', async () => {
    vi.stubEnv('FIRECRAWL_API_KEY', '');
    await expect(documentSections(bytes, 'document.pdf')).rejects.toMatchObject({ code: 'parse_failed' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [429, 'rate_limited'], [413, 'source_too_large'], [401, 'parse_failed'], [500, 'parse_failed'],
  ])('handles HTTP %i without logging provider response contents', async (status, code) => {
    fetchMock.mockResolvedValueOnce(new Response('private document text and fc-test-key', { status }));
    await expect(documentSections(bytes, 'document.pdf')).rejects.toMatchObject({ code, message: `Firecrawl document parsing returned HTTP ${status}` });
  });

  it.each(['timeout', 'network'])('handles a %s failure without exposing credentials or document text', async (failure) => {
    fetchMock.mockRejectedValueOnce(failure === 'timeout' ? new DOMException('fc-test-key', 'TimeoutError') : new Error('private document text'));
    await expect(documentSections(bytes, 'document.pdf')).rejects.toMatchObject({
      code: 'parse_failed', message: 'Firecrawl document parsing request failed or timed out',
    });
  });

  it.each([
    { success: false, error: 'failed' },
    { success: true, data: null },
    { success: true, data: { pages: [{ pageNumber: 0, markdown: 'Wrong page' }] } },
    { success: true, data: { pages: [{ pageNumber: 1, markdown: null }] } },
  ])('rejects malformed or unsuccessful responses: %j', async (response) => {
    fetchMock.mockResolvedValueOnce(Response.json(response));
    await expect(documentSections(bytes, 'document.pdf')).rejects.toMatchObject({ code: 'parse_failed' });
  });

  it('rejects non-JSON responses', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>Bad gateway</html>'));
    await expect(documentSections(bytes, 'document.pdf')).rejects.toMatchObject({ code: 'parse_failed' });
  });

  it('does not cool down a key that answered, even when its reply cannot be used', async () => {
    const credential = { id: 'first', apiKey: 'fc-console-first' };
    vi.mocked(claimFirecrawlKey).mockResolvedValueOnce({ managed: true, credential });
    fetchMock.mockResolvedValueOnce(new Response('<html>not json</html>', { status: 200 }));
    await expect(documentSections(bytes, 'document.pdf')).rejects.toMatchObject({ code: 'parse_failed' });
    expect(vi.mocked(recordFirecrawlKeyResult).mock.calls).toEqual([[credential, 200, null]]);
  });

  it('cools down a key whose request itself failed', async () => {
    const credential = { id: 'first', apiKey: 'fc-console-first' };
    vi.mocked(claimFirecrawlKey).mockResolvedValueOnce({ managed: true, credential });
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(documentSections(bytes, 'document.pdf')).rejects.toMatchObject({ code: 'parse_failed' });
    expect(recordFirecrawlKeyResult).toHaveBeenCalledWith(credential, 0);
  });

  describe('metered', () => {
    const rate = providerRateSchema.parse({ service: 'firecrawl', endpoint: 'https://api.firecrawl.dev', model: 'parse', unit: 'firecrawl_credits', usdPerUnit: '0.0038', source: 'test plan' });
    const metered = async <T>(work: () => Promise<T>) => {
      const charges: ProviderCharge[] = [];
      const result = withProviderMeter({ runId: 'run', prices: { revision: 'v1', rates: [rate] }, record: async (charge) => { charges.push(charge); } }, work);
      return { result, charges };
    };

    it('bills a PDF at its documented 1 credit per page when creditsUsed is missing', async () => {
      reply({ pages: [{ pageNumber: 1, markdown: 'One.' }, { pageNumber: 2, markdown: 'Two.' }], metadata: { numPages: 2, totalPages: 2 } });
      const { result, charges } = await metered(() => documentSections(bytes, 'document.pdf'));
      await result;
      expect(charges[0]).toMatchObject({ usage: { firecrawlCredits: 2 }, costUsd: '0.007600000000' });
    });

    it('bills the pages a reply returned when it reports no usage', async () => {
      reply({ pages: [{ pageNumber: 1, markdown: 'One.' }] });
      const { result, charges } = await metered(() => documentSections(bytes, 'document.pdf'));
      await result;
      expect(charges[0]).toMatchObject({ usage: { firecrawlCredits: 1 }, costUsd: '0.003800000000' });
    });

    it('bills the largest page count of a truncated reply, never the pages it returned', async () => {
      reply({ pages: [{ pageNumber: 1, markdown: 'One.' }, { pageNumber: 2, markdown: 'Two.' }], metadata: { numPages: 2, totalPages: 5 } });
      const { result, charges } = await metered(() => documentSections(bytes, 'document.pdf'));
      await expect(result).rejects.toMatchObject({ code: 'parse_failed' });
      expect(charges[0]).toMatchObject({ usage: { firecrawlCredits: 5 }, costUsd: '0.019000000000' });
    });

    it('still fails a reply with neither usage nor any page count', async () => {
      reply({});
      const { result, charges } = await metered(() => documentSections(bytes, 'document.pdf'));
      await expect(result).rejects.toThrow('usage_unavailable');
      expect(charges[0]).toMatchObject({ costUsd: null });
    });

    it('reserves the local page count at 1 credit per page before sending the file', async () => {
      const pdf = buildPdf([draw.image(), draw.image(), draw.image()]);
      const reserved: string[] = [];
      let sentAfterReserve = false;
      fetchMock.mockImplementationOnce(async () => { sentAfterReserve = reserved.length === 1; return Response.json({ success: true, data: { pages: [1, 2, 3].map((pageNumber) => ({ pageNumber, markdown: `Page ${pageNumber}.` })), metadata: { creditsUsed: 3 } } }); });
      await withProviderMeter({ runId: 'run', prices: { revision: 'v1', rates: [rate] }, record: async () => undefined, reserve: async (cost) => { reserved.push(cost); return () => undefined; } },
        () => documentSections(pdf, 'scan.pdf'));
      expect(reserved).toEqual(['0.011400000000']);
      expect(sentAfterReserve).toBe(true);
    });

    it('releases each rotated key\'s page estimate, so a retry does not reserve the pages twice', async () => {
      const pdf = buildPdf([draw.image(), draw.image(), draw.image()]);
      vi.mocked(claimFirecrawlKey)
        .mockResolvedValueOnce({ managed: true, credential: { id: 'first', apiKey: 'fc-console-first' } })
        .mockResolvedValueOnce({ managed: true, credential: { id: 'second', apiKey: 'fc-console-second' } });
      fetchMock.mockResolvedValueOnce(new Response('', { status: 429 }));
      reply({ pages: [1, 2, 3].map((pageNumber) => ({ pageNumber, markdown: `Page ${pageNumber}.` })), metadata: { creditsUsed: 3 } });
      const inflight = new Set<number>();
      const peaks: number[] = [];
      let next = 0;
      await withProviderMeter({
        runId: 'run', prices: { revision: 'v1', rates: [rate] }, record: async () => undefined,
        reserve: async () => { const key = next++; inflight.add(key); peaks.push(inflight.size); return () => { inflight.delete(key); }; },
      }, () => documentSections(pdf, 'scan.pdf'));
      expect(peaks).toEqual([1, 1]);
      expect(inflight.size).toBe(0);
    });

    it('makes no paid call when the balance cannot cover the reserved pages', async () => {
      const pdf = buildPdf([draw.image(), draw.image(), draw.image()]);
      const calls = fetchMock.mock.calls.length;
      await expect(withProviderMeter({ runId: 'run', prices: { revision: 'v1', rates: [rate] }, record: async () => undefined, reserve: async () => { throw new InsufficientCredits(115, 10); } },
        () => documentSections(pdf, 'scan.pdf'))).rejects.toBeInstanceOf(InsufficientCredits);
      expect(fetchMock.mock.calls.length).toBe(calls);
    });

    it('keeps an unreadable but billed reply as an unresolved receipt', async () => {
      fetchMock.mockResolvedValueOnce(new Response('<html>not json</html>', { status: 200 }));
      const { result, charges } = await metered(() => documentSections(bytes, 'document.pdf'));
      await expect(result).rejects.toMatchObject({ code: 'parse_failed' });
      expect(charges).toEqual([expect.objectContaining({ costUsd: null, basis: 'unresolved' })]);
    });
  });

  it('rejects PDF output without per-page data instead of attributing all text to page one', async () => {
    reply({ markdown: 'This could have come from any page.' });
    await expect(documentSections(bytes, 'document.pdf')).rejects.toMatchObject({ code: 'parse_failed' });
  });

  it('rejects duplicate page numbers', async () => {
    reply({ pages: [{ pageNumber: 1, markdown: 'One' }, { pageNumber: 1, markdown: 'Two' }] });
    await expect(documentSections(bytes, 'document.pdf')).rejects.toMatchObject({ code: 'parse_failed' });
  });

  it('rejects explicitly truncated documents', async () => {
    reply({ pages: [{ pageNumber: 1, markdown: 'One' }], metadata: { numPages: 1, totalPages: 100 } });
    await expect(documentSections(bytes, 'document.pdf')).rejects.toMatchObject({ code: 'parse_failed', message: 'Firecrawl returned a truncated document' });
  });

  it('rejects per-page output that does not match the declared page count', async () => {
    reply({ pages: [{ pageNumber: 1, markdown: 'One' }], metadata: { numPages: 3, totalPages: 3 } });
    await expect(documentSections(bytes, 'document.pdf')).rejects.toMatchObject({ code: 'parse_failed', message: 'Firecrawl returned incomplete PDF page data' });
  });

  it('stops before calling Firecrawl when the deadline has passed', async () => {
    await expect(firecrawlSections(bytes, 'document.pdf', { deadline: Date.now() - 1 })).rejects.toMatchObject({
      code: 'parse_failed', message: 'Firecrawl document parsing timed out',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a PDF Firecrawl finds empty', async () => {
    reply({ pages: [{ pageNumber: 1, markdown: ' \n ' }] });
    await expect(documentSections(bytes, 'document.pdf')).rejects.toMatchObject({ code: 'empty_text' });
  });
});

/** Runs `work` inside a provider meter and returns what it recorded. */
async function chargesOf(work: () => Promise<unknown>): Promise<ProviderCharge[]> {
  const charges: ProviderCharge[] = [];
  await withProviderMeter({ runId: 'run', prices: { revision: 'v1', rates: [] }, record: async (charge) => { charges.push(charge); } }, work);
  return charges;
}

/** A report page: running header, title, heading, two paragraphs, a list, and a page-number footer. */
function reportPage(n: number, total: number): string {
  return [
    draw.text('ACME Confidential', { y: 815, size: 9 }),
    draw.text(n === 1 ? 'Annual Report' : `Part ${n}`, { y: 760, size: 24 }),
    draw.text('Revenue overview', { y: 720, size: 15 }),
    draw.text(`Revenue grew in region ${n} this year, led by`, { y: 696 }),
    draw.text('strong demand for the new devices.', { y: 682 }),
    draw.text('A second paragraph starts after a wider gap.', { y: 650 }),
    draw.text('• First bullet point', { y: 630 }),
    draw.text('• Second bullet point', { y: 616 }),
    draw.text(`Page ${n} of ${total}`, { y: 30, size: 9 }),
  ].join(' ');
}

describe('local PDF parsing', () => {
  it('reads a text PDF without Firecrawl and rebuilds headings, paragraphs and lists', async () => {
    vi.stubEnv('FIRECRAWL_API_KEY', '');
    const sections = await documentSections(buildPdf([reportPage(1, 1)]), 'report.pdf');
    // One page cannot show a header repeating, but a bare page number at the edge is still dropped.
    expect(sections).toEqual([{
      text: [
        'ACME Confidential',
        '# Annual Report',
        '## Revenue overview',
        'Revenue grew in region 1 this year, led by strong demand for the new devices.',
        'A second paragraph starts after a wider gap.',
        '- First bullet point\n- Second bullet point',
      ].join('\n\n'),
      locator: { page: 1 },
    }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('strips headers and footers that repeat at the same place, and keeps physical page numbers past a blank page', async () => {
    const sections = await documentSections(buildPdf([reportPage(1, 4), '', reportPage(3, 4), reportPage(4, 4)]), 'report.pdf');
    expect(sections.map((section) => section.locator.page)).toEqual([1, 3, 4]);
    expect(sections.map((section) => section.text).join('\n')).not.toMatch(/ACME Confidential|Page \d of 4/);
    expect(sections[1]!.text).toContain('Revenue grew in region 3');

    const chunk = chunkSections(sections).find((chunk) => chunk.content.includes('region 3'))!;
    const citations = citationSnapshots('Revenue grew. [1]', [{
      ...chunk, chunkId: 'chunk', knowledgeId: 'source', title: 'Report', kind: 'document', similarity: 1,
    }]);
    expect(citations[0]!.locator).toMatchObject({ page: 3, heading: 'Part 3 › Revenue overview' });
  });

  it('keeps a running line that changes from page to page', async () => {
    const pages = ['Onboarding', 'Billing', 'Refunds'].map((topic, index) => [`Chapter ${index + 1}: ${topic}`, '', `How ${topic.toLowerCase()} works.`]);
    const sections = await documentSections(makePdf(pages), 'handbook.pdf');
    expect(sections.map((section) => section.text)).toEqual([
      'Chapter 1: Onboarding\n\nHow onboarding works.', 'Chapter 2: Billing\n\nHow billing works.', 'Chapter 3: Refunds\n\nHow refunds works.',
    ]);
  });

  it('records no provider call', async () => {
    expect(await chargesOf(() => documentSections(makePdf([['Local text only.']]), 'local.pdf'))).toEqual([]);
  });

  it('sends the whole file to Firecrawl when any page is an image without text', async () => {
    const scanned = buildPdf([reportPage(1, 3), draw.image(), reportPage(3, 3)]);
    const original = new Uint8Array(scanned);
    reply({ pages: [1, 2, 3].map((pageNumber) => ({ pageNumber, markdown: `OCR page ${pageNumber}` })), metadata: { numPages: 3, totalPages: 3 } });
    const sections = await documentSections(scanned, 'scan.pdf');
    expect(sections.map((section) => section.locator.page)).toEqual([1, 2, 3]);
    expect(sections[1]!.text).toBe('OCR page 2');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // pdf.js detaches what it parses; Firecrawl still receives every byte of the original.
    const form = fetchMock.mock.calls[0]![1]!.body as FormData;
    expect(new Uint8Array(await (form.get('file') as File).arrayBuffer())).toEqual(original);
  });

  it('parses a figure locally when its caption is body text', async () => {
    const caption = [draw.image({ y: 160 }), draw.text('Figure 1: the device from the front, with every port labelled for reference.', { y: 130 })].join(' ');
    expect(await documentSections(buildPdf([caption]), 'figure.pdf')).toEqual([
      { text: 'Figure 1: the device from the front, with every port labelled for reference.', locator: { page: 1 } },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('parses locally past a cover page with a logo and a short title', async () => {
    const cover = [draw.image({ x: 56, y: 700, width: 90, height: 60 }), draw.text('Annual Report 2025', { y: 600, size: 24 })].join(' ');
    const sections = await documentSections(buildPdf([cover, reportPage(2, 3), reportPage(3, 3)]), 'report.pdf');
    expect(sections.map((section) => section.locator.page)).toEqual([1, 2, 3]);
    expect(sections[0]!.text).toBe('# Annual Report 2025');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([1, 3])('sends a %i-page scan stamped with a digital header to Firecrawl', async (count) => {
    const stamped = Array.from({ length: count }, (_, at) => [
      draw.text(`Confidential - ACME Corp - Bates ACME-00012${at} - Page ${at + 1} of ${count}`, { y: 815, size: 9 }),
      draw.image(),
    ].join(' '));
    reply({ pages: Array.from({ length: count }, (_, at) => ({ pageNumber: at + 1, markdown: `OCR page ${at + 1}` })) });
    expect((await documentSections(buildPdf(stamped), 'scan.pdf')).map((section) => section.text)[0]).toBe('OCR page 1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reads CJK text in a font that needs one of pdf.js\'s predefined CMaps', async () => {
    expect(await documentSections(buildPdf([[draw.text('Product manual', { y: 760 }), draw.cjk(700)].join(' ')]), 'manual.pdf')).toEqual([
      { text: 'Product manual\n\n中文', locator: { page: 1 } },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['garbled text', buildPdf([draw.text('This line maps every glyph into the private-use area.', { y: 700, font: 'F2' })])],
    ['a font that cannot be loaded', buildPdf([[draw.text('Latin text extracts while the CJK font beside it fails.', { y: 760 }), draw.cjk(700, { broken: true })].join(' ')])],
    ['no text on any page', buildPdf(['', ''])],
    ['nothing but page numbers', buildPdf(['1', '2', '3'].map((n) => draw.text(n, { x: 300, y: 30 })))],
  ])('sends the file to Firecrawl for %s', async (_case, pdf) => {
    reply({ pages: [{ pageNumber: 1, markdown: 'Parsed by Firecrawl.' }] });
    expect(await documentSections(pdf, 'document.pdf')).toEqual([{ text: 'Parsed by Firecrawl.', locator: { page: 1 } }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('parses locally when garbled characters are only a trace', async () => {
    const pdf = buildPdf([[
      draw.text('Plenty of clean text on this page keeps the share of bad characters small,', { y: 700 }),
      draw.text('so a single stray glyph does not send the file away.', { y: 686 }),
      draw.text('x', { x: 400, y: 686, font: 'F2' }),
    ].join(' ')]);
    const [section] = await documentSections(pdf, 'document.pdf');
    expect(section!.text).toContain('Plenty of clean text');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('escapes body lines that would read as Markdown, and keeps its own headings and bullets', async () => {
    const page = [
      draw.text('Setup', { y: 760, size: 15 }),
      draw.text('# install deps', { y: 730 }),
      draw.text('```', { y: 700 }),
      draw.text('> not a quote', { y: 670 }),
      draw.text('• A real bullet', { y: 640 }),
      draw.text('The rest of the page stays outside any code block.', { y: 610 }),
    ].join(' ');
    const sections = await documentSections(buildPdf([page]), 'setup.pdf');
    expect(sections[0]!.text).toBe([
      '## Setup', '\\# install deps', '\\```', '\\> not a quote', '- A real bullet', 'The rest of the page stays outside any code block.',
    ].join('\n\n'));
    const chunks = chunkSections(sections);
    expect(chunks.map((chunk) => chunk.locator.heading)).toEqual(['Setup']);
    expect(chunks[0]!.content).toContain('The rest of the page');
  });

  it('keeps a line drawn out of order in one paragraph', async () => {
    const page = [
      draw.text('world, drawn before its first word,', { x: 88, y: 700 }),
      draw.text('Hello', { y: 700 }),
      draw.text('and the sentence goes on below.', { y: 686 }),
    ].join(' ');
    expect((await documentSections(buildPdf([page]), 'order.pdf'))[0]!.text).toBe('Hello world, drawn before its first word, and the sentence goes on below.');
  });

  it('keeps columns drawn one after the other apart', async () => {
    const page = [
      draw.text('Left column first line', { y: 700 }), draw.text('left column second line.', { y: 686 }),
      draw.text('Right column first line', { x: 320, y: 700 }), draw.text('right column second line.', { x: 320, y: 686 }),
    ].join(' ');
    expect((await documentSections(buildPdf([page]), 'columns.pdf'))[0]!.text)
      .toBe('Left column first line left column second line.\n\nRight column first line right column second line.');
  });

  it('strips bare page numbers only when they rise from page to page', async () => {
    const body = (text: string) => draw.text(text, { y: 700 });
    const numbered = (marks: string[]) => buildPdf(marks.map((mark, at) => [body(`Body of page ${at + 1}.`), draw.text(mark, { x: 300, y: 30 })].join(' ')));
    for (const marks of [['1', '2', '3'], ['i', 'ii', 'iii']]) {
      expect((await documentSections(numbered(marks), 'numbered.pdf')).map((section) => section.text)).toEqual(['Body of page 1.', 'Body of page 2.', 'Body of page 3.']);
    }
    // A one-page invoice's total, and words that only look like roman numerals, stay.
    expect((await documentSections(numbered(['1500']), 'invoice.pdf'))[0]!.text).toBe('Body of page 1.\n\n1500');
    expect((await documentSections(numbered(['civic', 'ill']), 'words.pdf')).map((section) => section.text)).toEqual(['Body of page 1.\n\ncivic', 'Body of page 2.\n\nill']);
    expect((await documentSections(numbered(['7', '7', '7']), 'same.pdf')).map((section) => section.text.endsWith('7'))).toEqual([true, true, true]);
  });

  it('hands the file to Firecrawl when local reading runs out of time', async () => {
    expect(await pdfTextLayer(makePdf([['Local text.']]), { deadline: Date.now() - 1 })).toEqual({ fallback: 'budget', page: 1, pages: 1 });

    const base = Date.now();
    let calls = 0;
    // The document deadline and the local budget start at `base`; every later reading is 70 s on.
    const now = vi.spyOn(Date, 'now').mockImplementation(() => (calls++ < 2 ? base : base + 70_000));
    try {
      reply({ pages: [{ pageNumber: 1, markdown: 'Parsed by Firecrawl.' }] });
      expect(await documentSections(makePdf([['Local text.']]), 'slow.pdf')).toEqual([{ text: 'Parsed by Firecrawl.', locator: { page: 1 } }]);
    } finally {
      now.mockRestore();
    }
    const form = fetchMock.mock.calls[0]![1]!.body as FormData;
    // Firecrawl gets what is left of the document's 120 s, not a fresh 120 s.
    expect(JSON.parse(form.get('options') as string).timeout).toBe(50_000);
  });
});

describe('local Word parsing', () => {
  const policy = makeDocx([
    word.heading(1, 'Warranty'),
    word.paragraph('Devices are covered for two years.'),
    word.heading(2, 'Exclusions'),
    word.bullet('Water damage'),
    word.bullet('Lost devices'),
    word.table([['Item', 'Years'], ['Device', '2'], ['Battery | pack', '1']]),
  ]);

  it('turns headings, lists and tables into Markdown without Firecrawl or page numbers', async () => {
    vi.stubEnv('FIRECRAWL_API_KEY', '');
    const sections = await documentSections(policy, 'policy.DOCX');
    expect(sections).toEqual([{
      text: [
        '# Warranty',
        'Devices are covered for two years.',
        '## Exclusions',
        '-   Water damage\n-   Lost devices',
        '| Item | Years |\n| --- | --- |\n| Device | 2 |\n| Battery \\| pack | 1 |',
      ].join('\n\n'),
      locator: {},
    }]);
    expect(fetchMock).not.toHaveBeenCalled();
    const chunk = chunkSections(sections).find((chunk) => chunk.content.includes('Water damage'))!;
    expect(chunk.locator).toMatchObject({ heading: 'Warranty › Exclusions' });
  });

  it('records no provider call', async () => {
    expect(await chargesOf(() => documentSections(policy, 'policy.docx'))).toEqual([]);
  });

  it.each([
    ['not a zip', new Uint8Array([80, 75, 3, 4])],
    ['a zip without a Word document', makeZip({ 'notes.txt': 'Not Word.' })],
  ])('fails to parse %s', async (_case, file) => {
    await expect(documentSections(file, 'broken.docx')).rejects.toMatchObject({ code: 'parse_failed' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a Word document without text', async () => {
    await expect(documentSections(makeDocx([word.paragraph('  ')]), 'blank.docx')).rejects.toMatchObject({ code: 'empty_text' });
  });

  it('refuses a zip that inflates past the size cap, whatever its headers declare', async () => {
    const bomb = await deflatedZip('word/document.xml', 210 * 1024 * 1024);
    expect(bomb.length).toBeLessThan(1024 * 1024);
    await expect(documentSections(bomb, 'bomb.docx')).rejects.toMatchObject({ code: 'source_too_large' });
  });
});

describe('local text ingestion', () => {
  it.each(['md', 'txt'])('reads %s locally without Firecrawl credentials or requests', async (extension) => {
    vi.stubEnv('FIRECRAWL_API_KEY', '');
    const text = new TextEncoder().encode('\uFEFF# 标题\r\n\r正文\n');
    expect(await documentSections(text, `notes.${extension}`)).toEqual([{ text: '# 标题\n\n正文\n', locator: {} }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects unsupported documents before making a request', async () => {
    await expect(documentSections(bytes, 'document.exe')).rejects.toMatchObject({ code: 'unsupported_format' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
