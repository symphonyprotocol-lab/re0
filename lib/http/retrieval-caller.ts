/**
 * Who is asking, for the retrieval endpoints. architecture.md 12.1: Bearer API
 * keys authenticate a workspace; anonymous requests are allowed onto the open
 * Search/Context subset, but only through the anonymous rate limit -- which
 * fails CLOSED (architecture.md 11.2: a limiter that cannot count must not
 * wave unmetered trial traffic through).
 */
import type { NextRequest } from 'next/server';
import { AppError } from '@/contracts/errors';
import { resolveApiKey } from '@/lib/application/auth/api-key';
import { resolveSession } from '@/lib/application/auth';
import type { CallerContext } from '@/lib/application/retrieval';
import { rateLimitKey } from '@/lib/http/auth-endpoints';
import { SESSION_COOKIE } from '@/lib/http/session';
import type { RateLimitRule } from '@/lib/infrastructure/cache/redis';
import { strictRateLimit } from '@/lib/infrastructure/cache/strict-rate-limit';

/**
 * Wide enough to try the product, narrow enough that scraping the corpus
 * anonymously costs more than signing up.
 *
 * A long window rather than a generous hourly one: ten questions is enough to
 * decide whether the answers are worth an account, and spreading them over
 * five hours means a scraper waits out four idle hours per ten requests
 * instead of resetting every hour. The window length goes out with the count
 * (`TrialAllowance`, `trialHeaders`), so a client can say how long it is
 * rather than assume an hour.
 */
export const ANONYMOUS_RATE_RULE: RateLimitRule = { limit: 10, windowSeconds: 18_000 };

/**
 * What an anonymous caller has left of the trial window, counted after this
 * request. The limiter's verdict rides along with the caller instead of
 * being dropped on the floor once it said yes, so the response can report it.
 */
export interface TrialAllowance {
  limit: number;
  remaining: number;
  windowSeconds: number;
}

/** A caller plus, for an anonymous one, where it stands against the trial limit. */
export type RetrievalCaller = CallerContext & { trial: TrialAllowance | null };

/** Response headers carrying the trial allowance; none for a keyed or signed-in caller. */
export function trialHeaders(trial: TrialAllowance | null): Record<string, string> {
  if (!trial) return {};
  return {
    'x-re0-trial-limit': String(trial.limit),
    'x-re0-trial-remaining': String(trial.remaining),
    'x-re0-trial-window': String(trial.windowSeconds),
  };
}

/**
 * `entrypoint` is what the usage event and request log record: `rest` for
 * the /v1 routes, `mcp` for the MCP endpoint. The scope check happens at the
 * route, which knows which scope its operation needs (`requireScope`).
 */
export async function retrievalCaller(
  request: NextRequest,
  requestId: string,
  entrypoint: 'rest' | 'mcp' = 'rest',
): Promise<RetrievalCaller> {
  const principal = await resolveApiKey(request.headers.get('authorization'));

  if (principal) {
    return {
      workspaceId: principal.workspaceId,
      apiKeyId: principal.apiKeyId,
      requestId,
      anonymous: false,
      scopes: principal.scopes,
      entrypoint,
      trial: null,
    };
  }

  const verdict = await strictRateLimit(
    await rateLimitKey(request, 'retrieval'),
    ANONYMOUS_RATE_RULE,
  );
  if (!verdict.allowed) {
    throw new AppError('rate_limited', 'anonymous limit reached; retry later or use an API key');
  }

  return {
    workspaceId: null,
    apiKeyId: null,
    requestId,
    anonymous: true,
    entrypoint,
    trial: {
      limit: ANONYMOUS_RATE_RULE.limit,
      remaining: verdict.remaining,
      windowSeconds: ANONYMOUS_RATE_RULE.windowSeconds,
    },
  };
}

/**
 * The playground's caller: an API key, else the browser session. Nobody else.
 *
 * The playground is for signed-in users: its answers are generated at the
 * platform's cost, and an anonymous visitor only ever had the trial rate
 * limit standing between that cost and the open internet. The page lets
 * anyone look and asks a visitor without a session to sign in when they send
 * (components/site/playground); this is the rule itself, for every request.
 *
 * The retrieval endpoints above stay key-only -- a cookie must not
 * authenticate a cross-site POST to /v1. The playground is the site's own
 * page, and its promise to a signed-in visitor ("each exchange counts as one
 * API call") is only kept if the session is what the request runs as:
 * metered by the workspace's quota, and answered by the models the
 * workspace's plan buys.
 */
export async function playgroundCaller(
  request: NextRequest,
  requestId: string,
): Promise<CallerContext> {
  const principal = await resolveApiKey(request.headers.get('authorization'));
  if (principal) {
    return {
      workspaceId: principal.workspaceId,
      apiKeyId: principal.apiKeyId,
      requestId,
      anonymous: false,
      scopes: principal.scopes,
      entrypoint: 'web',
    };
  }

  const session = await resolveSession(request.cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    throw new AppError('access_denied', 'sign in to use the playground');
  }
  return {
    workspaceId: session.workspace.id,
    apiKeyId: null,
    requestId,
    anonymous: false,
    entrypoint: 'web',
  };
}
