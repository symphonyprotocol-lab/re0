import type { NextRequest } from 'next/server';
import { OAUTH_LIMITS } from '@/lib/constants';
import { OAuthError } from '@/lib/domain/oauth';
import { clientIp } from '@/lib/http/client-ip';
import { corsPreflight, limitedBody, oauthError, oauthJson } from '@/lib/http/oauth';
import { registerClient } from '@/lib/services/oauth';
import { hitRateBucket } from '@/lib/services/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * RFC 7591 dynamic client registration (deprecated by the MCP spec in favour
 * of metadata documents, still what most MCP clients do). Open to anyone,
 * so limited per address and overall (OAUTH_LIMITS: claude.ai and ChatGPT
 * register from shared server addresses, so the per-address limit is
 * generous); a registration grants nothing until a user approves it on the
 * consent page.
 */
export async function POST(request: NextRequest): Promise<Response> {
  const byAddress = await hitRateBucket(`oauth:register:${clientIp(request.headers) ?? 'unknown'}`, OAUTH_LIMITS.registrationsPerAddressPerHour, 3_600);
  const overall = byAddress && (await hitRateBucket('oauth:register:all', OAUTH_LIMITS.registrationsPerHour, 3_600));
  if (!byAddress || !overall) {
    const response = oauthError({ error: 'temporarily_unavailable', description: 'Too many client registrations; try again later, or identify the client with a metadata document URL instead.', status: 429 });
    response.headers.set('retry-after', '3600');
    return response;
  }
  try {
    const text = await limitedBody(request);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new OAuthError('invalid_client_metadata', 'The body must be a JSON object.');
    }
    return oauthJson(await registerClient(raw), 201);
  } catch (error) {
    if (error instanceof OAuthError) return oauthError(error);
    throw error;
  }
}

export const OPTIONS = corsPreflight;
