/**
 * The HTTP shell around the A2A server (agent-first-proposal.md 7.4, 7.8):
 * who is calling, which tenant, the anonymous limit, and turning the
 * server's answers into responses -- JSON, or `text/event-stream` written as
 * the generator yields, on the default Node.js runtime.
 *
 * Authentication is the API key as a Bearer token, its workspace the caller,
 * its scopes the existing ones: the P1 skills need `knowledge:search` or
 * `knowledge:read`. A header that is present but wrong is refused, never
 * quietly downgraded to anonymous. Without one the caller is anonymous:
 * public skills only, under the same fail-closed anonymous rate limit as
 * REST (architecture.md 11.2), counted on the calls that run a skill.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { AppError, httpStatusFor } from '@/contracts/errors';
import { resolveApiKey } from '@/lib/application/auth/api-key';
import { userByHandle } from '@/lib/application/channels';
import { agentCardJson, buildAgentCard, legacyAgentCardJson } from '@/lib/application/a2a/card';
import { handleA2A, type A2AResponse } from '@/lib/application/a2a/server';
import { resolveTenant, splitTenantPath, type A2ATenant } from '@/lib/application/a2a/tenant';
import { hasScope } from '@/lib/domain/api-key';
import { rateLimitKey } from '@/lib/http/auth-endpoints';
import { appBaseUrl } from '@/lib/http/base-url';
import { ANONYMOUS_RATE_RULE } from '@/lib/http/retrieval-caller';
import { anonymousVisitorKey } from '@/lib/http/visitor';
import { newRequestId } from '@/lib/http/respond';
import { strictRateLimit } from '@/lib/infrastructure/cache/strict-rate-limit';

const SSE_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
};

/** Agents call from servers and from browsers alike; nothing here rides on a cookie. */
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type, a2a-version, a2a-extensions, x-a2a-extensions',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-expose-headers': 'a2a-extensions',
};

/* The calls that run a skill or hold a function open polling the store. */
const LIMITED_METHODS = new Set([
  'SendMessage',
  'SendStreamingMessage',
  'SubscribeToTask',
  'message/send',
  'message/stream',
  'tasks/resubscribe',
]);

/** The deployment's origin, which the cards' interface URLs point at. */
export function a2aOrigin(): string {
  return appBaseUrl().replace(/\/+$/, '');
}

export function preflight(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

/* ------------------------------------------------------------------- cards */

async function cardFor(tenant: A2ATenant) {
  const hasPublicChannel = tenant.level === 'user' ? (await userByHandle(tenant.handle)) !== null : undefined;
  return buildAgentCard({ origin: a2aOrigin(), tenant, hasPublicChannel });
}

/**
 * A card, in the shape the caller speaks: v1.0 when it asks for 1.x, else
 * the v0.3 shape with the v1.0 interfaces embedded -- what the SDK's own card
 * route does with compatibility on, since a request without `A2A-Version`
 * means 0.3 to the specification.
 */
export async function serveCard(request: NextRequest, tenantKey: string): Promise<NextResponse> {
  const tenant = await resolveTenant(tenantKey);
  if (!tenant) return NextResponse.json({ error: 'no such agent' }, { status: 404, headers: CORS_HEADERS });
  const card = await cardFor(tenant);
  const version = request.headers.get('a2a-version');
  const body = version && !version.startsWith('0.') ? agentCardJson(card) : legacyAgentCardJson(card);
  return NextResponse.json(body, {
    headers: {
      ...CORS_HEADERS,
      'cache-control': 'public, max-age=300, s-maxage=300',
      vary: 'A2A-Version',
    },
  });
}

/* ---------------------------------------------------------------- requests */

export async function serveA2A(request: NextRequest, segments: readonly string[]): Promise<Response> {
  const requestId = newRequestId();
  const split = splitTenantPath(segments);
  const method = request.method.toUpperCase();

  if (method === 'GET' && split.rest.length === 1 && split.rest[0] === 'agent-card.json') {
    /* The platform card lives at /.well-known; under /a2a only user and channel cards do. */
    return split.tenant ? serveCard(request, split.tenant) : notFound();
  }

  const isJsonRpc = method === 'POST' && split.rest.length === 0;
  let body: unknown;
  if (method === 'POST') {
    const text = await request.text();
    if (text.trim().length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        return isJsonRpc
          ? json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 200)
          : json({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'the body is not JSON', details: [] } }, 400);
      }
    }
  }

  /* The tenant: a JSON-RPC body may name it; otherwise the path does. */
  const bodyTenant = isJsonRpc ? readBodyTenant(body) : null;
  if (bodyTenant && split.tenant && bodyTenant !== split.tenant) {
    return json({ jsonrpc: '2.0', id: rpcId(body), error: { code: -32602, message: 'the tenant in the body does not match the path' } }, 200);
  }
  const tenant = await resolveTenant(bodyTenant ?? split.tenant);
  if (!tenant) return notFound(isJsonRpc ? rpcId(body) : undefined);

  /* Who is calling. */
  let principal: Awaited<ReturnType<typeof resolveApiKey>>;
  try {
    principal = await resolveApiKey(request.headers.get('authorization'));
  } catch (error) {
    return appError(error, requestId);
  }
  if (principal && !hasScope(principal.scopes, 'knowledge:search') && !hasScope(principal.scopes, 'knowledge:read')) {
    return appError(new AppError('access_denied', 'this API key lacks the knowledge:search or knowledge:read scope'), requestId);
  }

  /* The anonymous limit, on the calls that run a skill or open a subscription. */
  const limited = isJsonRpc
    ? LIMITED_METHODS.has(String((body as { method?: unknown } | undefined)?.method ?? ''))
    : split.rest.some(
        (segment) => segment === 'message:send' || segment === 'message:stream' || segment.endsWith(':subscribe'),
      );
  if (!principal && limited) {
    try {
      const verdict = await strictRateLimit(await rateLimitKey(request, 'a2a'), ANONYMOUS_RATE_RULE);
      if (!verdict.allowed) throw new AppError('rate_limited', 'anonymous limit reached; retry later or use an API key');
    } catch (error) {
      return appError(error, requestId);
    }
  }

  const card = await cardFor(tenant);
  const result = await handleA2A({
    method,
    rest: split.rest,
    search: request.nextUrl.searchParams,
    body,
    version: request.headers.get('a2a-version'),
    card,
    origin: a2aOrigin(),
    pathTenant: !bodyTenant,
    facts: {
      caller: {
        workspaceId: principal?.workspaceId ?? null,
        apiKeyId: principal?.apiKeyId ?? null,
        requestId,
        anonymous: !principal,
        scopes: principal?.scopes,
        entrypoint: 'a2a',
      },
      tenant,
      anonymousVisitor: principal ? null : await anonymousVisitorKey(request.headers),
    },
  });
  return toResponse(result);
}

function readBodyTenant(body: unknown): string | null {
  const tenant = (body as { params?: { tenant?: unknown } } | undefined)?.params?.tenant;
  return typeof tenant === 'string' && tenant.trim().length > 0 ? tenant.trim() : null;
}

function rpcId(body: unknown): string | number | null {
  const id = (body as { id?: unknown } | undefined)?.id;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

function toResponse(result: A2AResponse): Response {
  if (result.kind === 'json') return json(result.body, result.status);
  if (result.kind === 'empty') return new NextResponse(null, { status: result.status, headers: CORS_HEADERS });
  const encoder = new TextEncoder();
  const { events, errorEvent } = result;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await events.next();
        if (next.done) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(next.value)}\n\n`));
      } catch (error) {
        controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify(errorEvent(error))}\n\n`));
        controller.close();
      }
    },
    async cancel() {
      await events.return(undefined);
    },
  });
  return new Response(stream, { headers: { ...SSE_HEADERS, ...CORS_HEADERS } });
}

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: { ...CORS_HEADERS, 'cache-control': 'private, no-store' } });
}

function notFound(id?: string | number | null): NextResponse {
  return id !== undefined
    ? json({ jsonrpc: '2.0', id, error: { code: -32602, message: 'no such agent' } }, 404)
    : json({ error: { code: 404, status: 'NOT_FOUND', message: 'no such agent', details: [] } }, 404);
}

function appError(error: unknown, requestId: string): NextResponse {
  const known = error instanceof AppError ? error : new AppError('internal_error', 'unexpected error');
  if (known.code === 'internal_error') console.error(`a2a internal error requestId=${requestId}`, error);
  const status = httpStatusFor(known.code);
  return NextResponse.json(
    { error: { code: known.code, message: known.code === 'internal_error' ? 'unexpected error' : known.message, requestId } },
    {
      status,
      headers: {
        ...CORS_HEADERS,
        ...(status === 401 ? { 'www-authenticate': 'Bearer realm="re0"' } : {}),
        ...(status === 429 ? { 'retry-after': '60' } : {}),
      },
    },
  );
}
