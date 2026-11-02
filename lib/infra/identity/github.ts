/**
 * GitHub OAuth, web application flow. GitHub's authorize endpoint has no
 * `code_challenge`, so the handshake relies on `state` alone (sealed in a
 * short-lived cookie). Identity only: `read:user user:email`.
 */
import { AuthFailure, type IdentityProfile } from '@/lib/domain/auth';

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const API_URL = 'https://api.github.com';
const SCOPE = 'read:user user:email';
const TIMEOUT_MS = 8_000;

function clientId(): string {
  const value = process.env.GITHUB_OAUTH_CLIENT_ID;
  if (!value) throw new Error('GITHUB_OAUTH_CLIENT_ID is not set');
  return value;
}

function clientSecret(): string {
  const value = process.env.GITHUB_OAUTH_CLIENT_SECRET;
  if (!value) throw new Error('GITHUB_OAUTH_CLIENT_SECRET is not set');
  return value;
}

export function authorizeUrl(input: { state: string; redirectUri: string }): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', clientId());
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('state', input.state);
  url.searchParams.set('allow_signup', 'true');
  return url.toString();
}

async function accessToken(code: string, redirectUri: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ client_id: clientId(), client_secret: clientSecret(), code, redirect_uri: redirectUri }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch {
    throw new AuthFailure('provider_unavailable', 'github token endpoint unreachable');
  }
  if (!response.ok) throw new AuthFailure('provider_unavailable', `github token endpoint ${response.status}`);
  const body = (await response.json()) as { access_token?: string; error?: string };
  if (!body.access_token) {
    throw new AuthFailure('oauth_failed', `github token exchange rejected: ${body.error ?? 'no token'}`);
  }
  return body.access_token;
}

async function apiGet<T>(path: string, token: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 're0',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch {
    throw new AuthFailure('provider_unavailable', `github ${path} unreachable`);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new AuthFailure(
      response.status === 401 || response.status === 404 ? 'oauth_failed' : 'provider_unavailable',
      `github ${path} returned ${response.status}`,
    );
  }
  return (await response.json()) as T;
}

interface GithubUser {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string | null;
}

interface GithubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

export async function exchange(input: { code: string; redirectUri: string }): Promise<IdentityProfile> {
  const token = await accessToken(input.code, input.redirectUri);
  const [profile, emails] = await Promise.all([
    apiGet<GithubUser>('/user', token),
    apiGet<GithubEmail[]>('/user/emails', token),
  ]);
  const primary = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified);
  if (!primary) throw new AuthFailure('email_unverified', 'github account has no verified email');
  return {
    provider: 'github',
    subject: String(profile.id),
    handle: profile.login,
    email: primary.email,
    displayName: profile.name ?? profile.login,
    avatarUrl: profile.avatar_url,
  };
}
