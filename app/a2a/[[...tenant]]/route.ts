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
/*
 * Must equal A2A_MAX_DURATION_S (lib/application/a2a/task-events.ts); Next
 * reads this as a literal. A blocking `ask` runs the whole generation chain
 * inside it, and the chain's model timeouts are idle limits the console
 * sets up to minutes each, so 60 s cut legitimate answers off mid-task. The
 * drain fails a task that still outruns it (`failStaleTasks`); the Calls it
 * held are never committed. A SubscribeToTask stream still ends at 50 s for
 * the client to reconnect.
 */
export const maxDuration = 300;

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
