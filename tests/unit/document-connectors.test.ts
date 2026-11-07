import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chunkSections } from '@/lib/domain/knowledge';
import { citationSnapshots, locatorLabel } from '@/lib/domain/answer';
import { documentSections } from '@/lib/infra/connectors';
import { claimFirecrawlKey, recordFirecrawlKeyResult } from '@/lib/infra/firecrawl/keys';
import { withProviderMeter } from '@/lib/infra/ai/provider-meter';
import { providerRateSchema, type ProviderCharge } from '@/lib/domain/provider-cost';

vi.mock('@/lib/infra/firecrawl/keys', () => ({ claimFirecrawlKey: vi.fn(), recordFirecrawlKeyResult: vi.fn() }));

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

describe('Firecrawl document ingestion', () => {
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
    expect(JSON.parse(form.get('options') as string)).toMatchObject({
      formats: ['markdown'], onlyMainContent: false, timeout: 120_000,
      parsers: [{ type: 'pdf', mode: 'auto', pages: true }],
    });

    const chunk = chunkSections(sections).find((chunk) => chunk.content.includes('设备保修两年'))!;
    const citations = citationSnapshots('设备保修两年。[1]', [{
      ...chunk, chunkId: 'chunk', knowledgeId: 'source', title: '产品手册', kind: 'document', similarity: 1,
    }]);
    expect(citations[0]!.locator).toMatchObject({ page: 3, heading: '保修' });
    expect(locatorLabel(citations[0]!.locator, 'zh')).toContain('第 3 页');
  });

  it('uploads Word documents and retains Markdown headings and tables without inventing page numbers', async () => {
    const markdown = '# Policy\n\n| Item | Years |\n| --- | --- |\n| Warranty | 2 |';
    reply({ markdown });
    expect(await documentSections(bytes, 'policy.DOCX')).toEqual([{ text: markdown, locator: {} }]);
    const form = fetchMock.mock.calls[0]![1]!.body as FormData;
    expect((form.get('file') as File).type).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(JSON.parse(form.get('options') as string)).not.toHaveProperty('parsers');
  });

  it('supports a self-hosted Parse server with an optional key', async () => {
    vi.stubEnv('FIRECRAWL_BASE_URL', 'http://localhost:3002/');
    vi.stubEnv('FIRECRAWL_API_KEY', '');
    reply({ markdown: 'Self-hosted document.' });
    await documentSections(bytes, 'notes.docx');
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

  it.each(['pdf', 'docx'])('refuses unconfigured %s parsing without a local fallback', async (extension) => {
    vi.stubEnv('FIRECRAWL_API_KEY', '');
    await expect(documentSections(bytes, `document.${extension}`)).rejects.toMatchObject({ code: 'parse_failed' });
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

    it('processes Word without creditsUsed and keeps its cost unresolved instead of guessing one', async () => {
      reply({ markdown: '# Warranty\n\nTwo years.' });
      const { result, charges } = await metered(() => documentSections(bytes, 'policy.docx'));
      expect(await result).toEqual([{ text: '# Warranty\n\nTwo years.', locator: {} }]);
      expect(charges).toEqual([expect.objectContaining({ service: 'firecrawl', costUsd: null, basis: 'unresolved' })]);
    });

    it('bills a PDF at its documented 1 credit per page when creditsUsed is missing', async () => {
      reply({ pages: [{ pageNumber: 1, markdown: 'One.' }, { pageNumber: 2, markdown: 'Two.' }], metadata: { numPages: 2, totalPages: 2 } });
      const { result, charges } = await metered(() => documentSections(bytes, 'document.pdf'));
      await result;
      expect(charges[0]).toMatchObject({ usage: { firecrawlCredits: 2 }, costUsd: '0.007600000000' });
    });

    it('still fails a PDF that reports no usage at all', async () => {
      reply({ pages: [{ pageNumber: 1, markdown: 'One.' }] });
      const { result, charges } = await metered(() => documentSections(bytes, 'document.pdf'));
      await expect(result).rejects.toThrow('usage_unavailable');
      expect(charges[0]).toMatchObject({ costUsd: null });
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

  it.each([
    ['pdf', { pages: [{ pageNumber: 1, markdown: ' \n ' }] }],
    ['docx', { markdown: ' \n ' }],
  ])('rejects empty %s documents', async (extension, data) => {
    reply(data);
    await expect(documentSections(bytes, `document.${extension}`)).rejects.toMatchObject({ code: 'empty_text' });
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
