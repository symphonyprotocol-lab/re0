import type { NextRequest } from 'next/server';
import { OAUTH_LIMITS } from '@/lib/constants';
import { OAuthError } from '@/lib/domain/oauth';
import { clientIp } from '@/lib/http/client-ip';
import { corsPreflight, oauthError, oauthJson } from '@/lib/http/oauth';
import { registerClient } from '@/lib/services/oauth';
import { hitRateBucket } from '@/lib/services/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * RFC 7591 dynamic client registration (deprecated by the MCP spec in favour
 * of metadata documents, still what most MCP clients do). Open to anyone,
 * so limited per address; a registration grants nothing until a user
 * approves it on the consent page.
 */
export async function POST(request: NextRequest): Promise<Response> {
  const allowed = await hitRateBucket(`oauth:register:${clientIp(request.headers) ?? 'unknown'}`, OAUTH_LIMITS.registrationsPerHour, 3_600);
  if (!allowed) return oauthError({ error: 'temporarily_unavailable', description: 'Too many registrations from this address; try again later.', status: 429 });
  const raw = await request.json().catch(() => undefined);
  try {
    return oauthJson(await registerClient(raw), 201);
  } catch (error) {
    if (error instanceof OAuthError) return oauthError(error);
    throw error;
  }
}

export const OPTIONS = corsPreflight;
