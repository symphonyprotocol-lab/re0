import type { NextRequest } from 'next/server';
import { OAuthError } from '@/lib/domain/oauth';
import { corsPreflight, oauthError, oauthParams, withCors } from '@/lib/http/oauth';
import { authenticateClient, revokeToken } from '@/lib/services/oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** RFC 7009 revocation: a refresh token ends its whole grant, an access token only itself; 200 even for an unknown token. */
export async function POST(request: NextRequest): Promise<Response> {
  try {
    const { params, basic } = await oauthParams(request);
    const client = await authenticateClient({ clientId: params.client_id, clientSecret: params.client_secret, basic });
    await revokeToken(client, params.token);
    return withCors(new Response(null, { status: 200, headers: { 'cache-control': 'no-store' } }));
  } catch (error) {
    if (error instanceof OAuthError) return oauthError(error);
    throw error;
  }
}

export const OPTIONS = corsPreflight;
