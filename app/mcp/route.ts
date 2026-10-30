/**
 * Remote MCP endpoint, stateless Streamable HTTP. architecture.md 13.1.
 *
 * Registers exactly two read-only tools, named identically everywhere:
 *   resolve-asset-id
 *   query-docs
 *
 * Both delegate to lib/application/retrieval -- the same functions REST uses;
 * no authorization, recall or metering logic lives here. Every POST builds a
 * fresh server context and holds no session (each request carries its own
 * Bearer key or rides the anonymous rate limit), so the endpoint scales like
 * any other stateless route. Implemented directly over JSON-RPC rather than an
 * SDK: the surface is three methods and two tools, and a dependency would be
 * larger than the code.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { AppError } from '@/contracts/errors';
import { queryDocsInputSchema, resolveAssetInputSchema } from '@/contracts/schemas';
import { requireScope } from '@/lib/application/auth';
import { queryDocs, resolveAssetId } from '@/lib/application/retrieval';
import { surfaceEnabled } from '@/lib/domain/surfaces';
import { retrievalCaller } from '@/lib/http/retrieval-caller';
import { newRequestId } from '@/lib/http/respond';

export const runtime = 'nodejs';

const PROTOCOL_VERSION = '2025-03-26';

const TOOLS = [
  {
    name: 'resolve-asset-id',
    description:
      'Find candidate assets for a question. Pass the question itself as `query` -- ' +
      'assets are matched by their content, and names on this platform often say ' +
      'nothing about it. `assetName` is an optional hint when a name is known. ' +
      'Each candidate carries evidence (matched titles and terms) plus trust and ' +
      'benchmark scores; pick from the evidence, then call query-docs with the chosen ' +
      'assetId. `versions` lists the labels that can be pinned, newest first: when ' +
      'the question is about a specific version, append its label to the assetId. ' +
      'Read-only and idempotent.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 2000, description: 'The user question or search intent.' },
        assetName: { type: 'string', minLength: 1, maxLength: 200, description: 'Optional asset-name hint.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'query-docs',
    description:
      'Retrieve cited documentation chunks from one asset. `assetId` comes from ' +
      'resolve-asset-id (form /owner/name, optionally /owner/name/version to pin a ' +
      'version). Returns chunks with citations, trimmed to maxTokens. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        assetId: { type: 'string', description: 'From resolve-asset-id, e.g. /vercel/next.js.' },
        query: { type: 'string', minLength: 1, maxLength: 2000 },
        maxTokens: { type: 'integer', minimum: 256, maximum: 64000, default: 4000 },
      },
      required: ['assetId', 'query'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
];

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: number | string | null, result: unknown): NextResponse {
  return NextResponse.json({ jsonrpc: '2.0', id, result });
}

function rpcError(id: number | string | null, code: number, message: string): NextResponse {
  return NextResponse.json({ jsonrpc: '2.0', id, error: { code, message } });
}

/** Tool failures are tool results, not protocol errors -- the model reads them. */
function toolFailure(id: number | string | null, error: unknown): NextResponse {
  const appError =
    error instanceof AppError ? error : new AppError('internal_error', 'unexpected error');
  return rpcResult(id, {
    content: [{ type: 'text', text: `${appError.code}: ${appError.message}` }],
    isError: true,
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  /* agent-first-proposal.md 3.6: MCP is offline; A2A (P1) takes its place. */
  if (!surfaceEnabled('mcp')) return new NextResponse(null, { status: 404 });
  const requestId = newRequestId();

  let message: JsonRpcRequest;
  try {
    message = (await request.json()) as JsonRpcRequest;
  } catch {
    return rpcError(null, -32700, 'parse error');
  }
  if (Array.isArray(message)) return rpcError(null, -32600, 'batching is not supported');

  const id = message.id ?? null;

  /* A notification (no id) acknowledges with 202 and no body. */
  if (message.id === undefined) return new NextResponse(null, { status: 202 });

  switch (message.method) {
    case 'initialize':
      /*
       * The spec says: answer with the requested version only if the server
       * supports it, otherwise with the server's own -- never echo blindly.
       */
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 're0', version: '1.0.0' },
      });

    case 'ping':
      return rpcResult(id, {});

    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });

    case 'tools/call': {
      const name = message.params?.name;
      const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        /* `mcp`, so the usage event and request log name this door. */
        const caller = await retrievalCaller(request, requestId, 'mcp');

        if (name === 'resolve-asset-id') {
          requireScope(caller, 'knowledge:search');
          const parsed = resolveAssetInputSchema.safeParse(args);
          if (!parsed.success) {
            throw new AppError('invalid_request', 'query is required (1-2000 characters)');
          }
          const output = await resolveAssetId(caller, parsed.data);
          return rpcResult(id, {
            content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
          });
        }

        if (name === 'query-docs') {
          requireScope(caller, 'knowledge:read');
          const parsed = queryDocsInputSchema.safeParse({ format: 'json', ...args });
          if (!parsed.success) {
            throw new AppError('invalid_request', 'assetId and query are required');
          }
          const output = await queryDocs(caller, parsed.data);
          return rpcResult(id, {
            content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
          });
        }

        return rpcError(id, -32602, `unknown tool: ${String(name)}`);
      } catch (error) {
        return toolFailure(id, error);
      }
    }

    default:
      return rpcError(id, -32601, `method not found: ${String(message.method)}`);
  }
}

/** Stateless: there is no server-initiated stream to open. */
export async function GET(): Promise<NextResponse> {
  if (!surfaceEnabled('mcp')) return new NextResponse(null, { status: 404 });
  return new NextResponse(null, { status: 405, headers: { allow: 'POST' } });
}
