/**
 * Google OAuth 2.0 / OpenID Connect.
 *
 * The full set: state (sealed cookie), PKCE S256 and a
 * nonce that is checked against the verified `id_token`. The token is verified
 * against Google's JWKS rather than trusted because it arrived over TLS, so a
 * misissued or replayed token fails closed.
 */
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { AuthFailure, type IdentityProfile } from '@/lib/domain/auth';

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

const SCOPE = 'openid email profile';
const TIMEOUT_MS = 8_000;

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

function keySet() {
  jwks ??= createRemoteJWKSet(new URL(JWKS_URL));
  return jwks;
}

function clientId(): string {
  const value = process.env.GOOGLE_OAUTH_CLIENT_ID;
  if (!value) throw new Error('GOOGLE_OAUTH_CLIENT_ID is not set');
  return value;
}

function clientSecret(): string {
  const value = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!value) throw new Error('GOOGLE_OAUTH_CLIENT_SECRET is not set');
  return value;
}

export function authorizeUrl(input: {
  state: string;
  nonce: string;
  codeChallenge: string;
  redirectUri: string;
}): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', clientId());
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('state', input.state);
  url.searchParams.set('nonce', input.nonce);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('access_type', 'online');
  url.searchParams.set('prompt', 'select_account');
  return url.toString();
}

interface GoogleTokenResponse {
  id_token?: string;
  error?: string;
}

export async function exchange(input: {
  code: string;
  codeVerifier: string;
  nonce: string;
  redirectUri: string;
}): Promise<IdentityProfile> {
  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId(),
        client_secret: clientSecret(),
        code: input.code,
        code_verifier: input.codeVerifier,
        grant_type: 'authorization_code',
        redirect_uri: input.redirectUri,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch {
    throw new AuthFailure('provider_unavailable', 'google token endpoint unreachable');
  }

  if (response.status >= 500) {
    throw new AuthFailure('provider_unavailable', `google token endpoint ${response.status}`);
  }

  const body = (await response.json().catch(() => ({}))) as GoogleTokenResponse;
  if (!response.ok || !body.id_token) {
    throw new AuthFailure('oauth_failed', `google token exchange rejected: ${body.error ?? 'no id_token'}`);
  }

  let claims: Record<string, unknown>;
  try {
    const verified = await jwtVerify(body.id_token, keySet(), {
      issuer: ISSUERS,
      audience: clientId(),
      maxTokenAge: '10 minutes',
    });
    claims = verified.payload as Record<string, unknown>;
  } catch {
    throw new AuthFailure('oauth_failed', 'google id_token failed verification');
  }

  if (claims.nonce !== input.nonce) {
    throw new AuthFailure('oauth_failed', 'google id_token nonce mismatch');
  }

  const subject = typeof claims.sub === 'string' ? claims.sub : '';
  const email = typeof claims.email === 'string' ? claims.email : '';
  if (!subject || !email) {
    throw new AuthFailure('oauth_failed', 'google id_token is missing sub or email');
  }
  if (claims.email_verified !== true) {
    throw new AuthFailure('email_unverified', 'google account email is not verified');
  }

  return {
    provider: 'google',
    subject,
    handle: email,
    email,
    displayName: typeof claims.name === 'string' ? claims.name : null,
    avatarUrl: typeof claims.picture === 'string' ? claims.picture : null,
  };
}
