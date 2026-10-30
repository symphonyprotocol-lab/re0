import { describe, expect, it, vi } from 'vitest';
import { callWebMcpTool, listWebMcpTools } from '@/lib/webmcp/client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('browser WebMCP adapter', () => {
  it('discovers the canonical tools from the existing MCP endpoint', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        jsonrpc: '2.0',
        id: 'webmcp',
        result: {
          tools: [
            {
              name: 'resolve-asset-id',
              description: 'Find an asset',
              inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
            },
          ],
        },
      }),
    );

    await expect(listWebMcpTools(fetcher)).resolves.toEqual([
      {
        name: 'resolve-asset-id',
        description: 'Find an asset',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      },
    ]);
    expect(fetcher).toHaveBeenCalledWith(
      '/mcp',
      expect.objectContaining({ method: 'POST', credentials: 'same-origin' }),
    );
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual({
      jsonrpc: '2.0',
      id: 'webmcp',
      method: 'tools/list',
    });
  });

  it('forwards calls and preserves readable tool failures', async () => {
    const result = {
      content: [{ type: 'text', text: 'asset_not_found: no such asset' }],
      isError: true,
    };
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ jsonrpc: '2.0', id: 'webmcp', result }),
    );

    await expect(
      callWebMcpTool('query-docs', { assetId: '/none/here', query: 'x' }, fetcher),
    ).resolves.toEqual(result);
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual({
      jsonrpc: '2.0',
      id: 'webmcp',
      method: 'tools/call',
      params: {
        name: 'query-docs',
        arguments: { assetId: '/none/here', query: 'x' },
      },
    });
  });

  it('rejects protocol errors and malformed responses', async () => {
    const refused = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ jsonrpc: '2.0', id: 'webmcp', error: { code: -32601, message: 'nope' } }),
    );
    await expect(listWebMcpTools(refused)).rejects.toThrow('nope');

    const malformed = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ result: { tools: null } }),
    );
    await expect(listWebMcpTools(malformed)).rejects.toThrow('invalid tool list');
  });
});
