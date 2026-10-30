/**
 * The platform Agent Card (agent-first-proposal.md 7.1): re0 as a whole,
 * with `find_channels` and `search_context` over every public channel's
 * free assets. The same generator serves the user and channel cards under
 * `/a2a` (lib/application/a2a/card.ts).
 */
import type { NextRequest } from 'next/server';
import { preflight, serveCard } from '@/lib/http/a2a';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<Response> {
  return serveCard(request, '');
}

export function OPTIONS(): Response {
  return preflight();
}
