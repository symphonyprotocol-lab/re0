/**
 * The visitor's side of the website widget: who a site key stands for, which
 * parent page may show it, and how much it may spend. requirement.md 9.4.
 *
 * A widget request runs *as the owner's workspace*: the Call is metered on
 * the workspace's quota and answered by the models its plan buys, exactly as
 * a signed-in owner asking the same question would be. What stops a public
 * key from draining that quota is not secrecy but two brakes applied here,
 * in order:
 *
 * 1. a per-visitor window, hashed from the address like the anonymous trial
 *    (architecture.md 11.2), so one browser cannot burn the site's day;
 * 2. the key's daily limit, one rolling day per key, set by the owner.
 *
 * Both run through the fail-closed limiter: a limiter that cannot count must
 * not wave someone else's quota through.
 */
import { and, asc, eq } from 'drizzle-orm';
import type { NextRequest } from 'next/server';
import { AppError } from '@/contracts/errors';
import type { CallerContext } from '@/lib/application/retrieval';
import { isAccountUsable } from '@/lib/domain/auth';
import { isSiteKeyFormat, originAllowed, widgetReady } from '@/lib/domain/site-key';
import { rateLimitKey } from '@/lib/http/auth-endpoints';
import type { RateLimitRule } from '@/lib/infrastructure/cache/redis';
import { strictRateLimit } from '@/lib/infrastructure/cache/strict-rate-limit';
import { db, schema } from '@/lib/infrastructure/postgres/client';

export interface SiteKeyPrincipal {
  siteKeyId: string;
  workspaceId: string;
  assetId: string;
  /** The asset's public id, the form retrieval takes (`/owner/name`). */
  assetPublicId: string;
  assetTitle: string;
  /** Published with a current version: the widget can answer right now. */
  ready: boolean;
  allowedOrigins: string[];
  dailyLimit: number;
  welcome: string | null;
  accent: string;
}

/**
 * One browser's share of a site's day. Generous for a reader, far too small
 * for a script: thirty questions an hour is a long support session.
 */
export const WIDGET_VISITOR_RULE: RateLimitRule = { limit: 30, windowSeconds: 3_600 };

const DAY_SECONDS = 86_400;

/**
 * Resolve a site key. Every failure is the same `invalid_api_key`: which check
 * failed is not information a caller holding a guessed key should receive.
 */
export async function resolveSiteKey(key: unknown): Promise<SiteKeyPrincipal> {
  if (!isSiteKeyFormat(key)) throw new AppError('invalid_api_key', 'unrecognised site key');

  const [row] = await db()
    .select({
      id: schema.siteKey.id,
      workspaceId: schema.siteKey.workspaceId,
      assetId: schema.siteKey.assetId,
      allowedOrigins: schema.siteKey.allowedOrigins,
      dailyLimit: schema.siteKey.dailyLimit,
      welcome: schema.siteKey.welcome,
      accent: schema.siteKey.accent,
      revokedAt: schema.siteKey.revokedAt,
      assetPublicId: schema.asset.publicId,
      assetTitle: schema.asset.title,
      lifecycleStatus: schema.asset.lifecycleStatus,
      currentVersionId: schema.asset.currentVersionId,
      deletedAt: schema.asset.deletedAt,
      ownerStatus: schema.user.status,
    })
    .from(schema.siteKey)
    .innerJoin(schema.asset, eq(schema.asset.id, schema.siteKey.assetId))
    /* The founding owner's account, as `resolveApiKey` reads it: a suspended
       account's widgets stop with its keys (requirement.md 3.2). */
    .leftJoin(
      schema.workspaceMember,
      and(
        eq(schema.workspaceMember.workspaceId, schema.siteKey.workspaceId),
        eq(schema.workspaceMember.role, 'owner'),
      ),
    )
    .leftJoin(schema.user, eq(schema.user.id, schema.workspaceMember.userId))
    .where(eq(schema.siteKey.key, key))
    .orderBy(asc(schema.workspaceMember.createdAt), asc(schema.workspaceMember.userId))
    .limit(1);

  if (!row || row.revokedAt || row.deletedAt) {
    throw new AppError('invalid_api_key', 'unknown or revoked site key');
  }
  if (row.ownerStatus !== null && !isAccountUsable(row.ownerStatus)) {
    throw new AppError('invalid_api_key', 'unknown or revoked site key');
  }

  return {
    siteKeyId: row.id,
    workspaceId: row.workspaceId,
    assetId: row.assetId,
    assetPublicId: row.assetPublicId,
    assetTitle: row.assetTitle,
    ready: widgetReady({
      lifecycleStatus: row.lifecycleStatus,
      hasCurrentVersion: row.currentVersionId !== null,
    }),
    allowedOrigins: row.allowedOrigins,
    dailyLimit: row.dailyLimit,
    welcome: row.welcome,
    accent: row.accent,
  };
}

/** The parent page must be one the owner listed; else `access_denied`. */
export function requireParentOrigin(principal: SiteKeyPrincipal, origin: string | null | undefined): void {
  if (!originAllowed(principal.allowedOrigins, origin)) {
    throw new AppError('access_denied', 'this site is not allowed to embed the widget');
  }
}

export interface WidgetAllowance {
  /** Of the key's daily limit, after this request. */
  remaining: number;
  limit: number;
}

/**
 * Admit one question: the visitor's window first, then the key's day. The
 * daily verdict is what the widget shows when a site has run out, so it rides
 * back with the admission rather than being dropped once it said yes.
 *
 * The visitor window is per site key: a browser that has used up one site's
 * share is not thereby shut out of every other site's widget. Called only
 * once the route knows the asset can answer, so attempts on an asset that
 * is still building do not spend the owner's day.
 */
export async function admitWidgetQuestion(
  request: NextRequest,
  principal: SiteKeyPrincipal,
): Promise<WidgetAllowance> {
  const visitor = await strictRateLimit(
    await rateLimitKey(request, `embed:${principal.siteKeyId}`),
    WIDGET_VISITOR_RULE,
  );
  if (!visitor.allowed) {
    throw new AppError('rate_limited', 'too many questions from this browser; retry later');
  }

  const daily = await strictRateLimit(`embed:daily:${principal.siteKeyId}`, {
    limit: principal.dailyLimit,
    windowSeconds: DAY_SECONDS,
  });
  if (!daily.allowed) {
    throw new AppError('quota_exceeded', 'this site has used its questions for today');
  }

  /* A usage timestamp, not an audit fact: losing one write is acceptable,
     failing the request over it is not. */
  db()
    .update(schema.siteKey)
    .set({ lastUsedAt: new Date() })
    .where(eq(schema.siteKey.id, principal.siteKeyId))
    .catch(() => {});

  return { remaining: daily.remaining, limit: principal.dailyLimit };
}

/** The widget asks as the owner's workspace, through the web door. */
export function widgetCaller(principal: SiteKeyPrincipal, requestId: string): CallerContext {
  return {
    workspaceId: principal.workspaceId,
    apiKeyId: null,
    requestId,
    anonymous: false,
    entrypoint: 'web',
  };
}
