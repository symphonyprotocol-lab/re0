/**
 * Firecrawl's Parse contract, without uploading integration fixtures to a
 * vendor. Only PDFs the local parser cannot read reach it (a scanned page, for
 * instance); it answers with the handbook's pages whatever the file holds.
 */
import { vi } from 'vitest';
import { handbookPages } from './pdf';
import { jsonResponse, startFakeWeb, type FakeWeb } from './fake-web';

export function startFakeFirecrawl(): FakeWeb {
  vi.stubEnv('FIRECRAWL_API_KEY', 'fc-integration-test');
  vi.stubEnv('FIRECRAWL_BASE_URL', 'https://api.firecrawl.dev');
  const web = startFakeWeb(['api.firecrawl.dev']);
  web.routes.set('api.firecrawl.dev/v2/parse', (_url, init) => {
    const file = (init!.body as FormData).get('file') as File;
    const pages = handbookPages().map((lines, index) => ({ pageNumber: index + 1, markdown: lines.join('\n') }));
    return jsonResponse({
      success: true,
      data: file.name.toLowerCase().endsWith('.pdf')
        ? { pages, markdown: pages.map((page) => page.markdown).join('\n\n'), metadata: { numPages: pages.length, totalPages: pages.length, creditsUsed: pages.length } }
        : { metadata: { creditsUsed: 1 }, markdown: '# Unexpected\n\nWord documents are parsed locally.' },
    });
  });
  return web;
}
