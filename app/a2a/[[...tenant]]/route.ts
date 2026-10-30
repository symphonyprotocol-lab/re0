/**
 * The A2A server: one endpoint for the three card levels, routed by tenant
 * (agent-first-proposal.md 7.1, 7.8). `/a2a` and `/a2a/{tenant}` take
 * JSON-RPC; `/a2a[/{tenant}]/message:send`, `/tasks/{id}` and the rest take
 * HTTP+JSON (`/v1/...` beneath them for v0.3 clients);
 * `/a2a/{users|channels}/{name}/agent-card.json` serves the user and channel
 * cards. Everything is in lib/http/a2a.ts.
 */
import type { NextRequest } from 'next/server';
import { preflight, serveA2A } from '@/lib/http/a2a';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/* A SubscribeToTask stream reads the store for up to 50 s, then ends for the client to reconnect. */
export const maxDuration = 60;

type Context = { params: Promise<{ tenant?: string[] }> };

async function handle(request: NextRequest, context: Context): Promise<Response> {
  const { tenant } = await context.params;
  return serveA2A(request, tenant ?? []);
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;

export function OPTIONS(): Response {
  return preflight();
}
