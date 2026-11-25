import type { NextRequest } from 'next/server';
import { OAuthError } from '@/lib/domain/oauth';
import { corsPreflight, oauthError, oauthJson, oauthParams } from '@/lib/http/oauth';
import { authenticateClient, exchangeCode, refreshTokens } from '@/lib/services/oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The token endpoint: `authorization_code` (with PKCE) and `refresh_token`
 * grants, for public clients by `client_id` and confidential ones by their
 * secret (Basic or in the body). Tokens appear in the response only.
 */
export async function POST(request: NextRequest): Promise<Response> {
  try {
    const { params, basic } = await oauthParams(request);
    const client = await authenticateClient({ clientId: params.client_id, clientSecret: params.client_secret, basic });
    if (params.grant_type === 'authorization_code') {
      return oauthJson(await exchangeCode(client, { code: params.code, redirectUri: params.redirect_uri, codeVerifier: params.code_verifier, resource: params.resource }));
    }
    if (params.grant_type === 'refresh_token') {
      return oauthJson(await refreshTokens(client, { refreshToken: params.refresh_token, resource: params.resource }));
    }
    throw new OAuthError(params.grant_type ? 'unsupported_grant_type' : 'invalid_request', params.grant_type ? 'Only authorization_code and refresh_token are supported.' : 'grant_type is required.');
  } catch (error) {
    if (error instanceof OAuthError) return oauthError(error);
    throw error;
  }
}

export const OPTIONS = corsPreflight;
