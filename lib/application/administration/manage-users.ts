/**
 * Use cases behind the registered-user screens: one account in full, and the
 * enable/suspend decision an operator takes on it.
 *
 * requirement.md 5.3 asks the console to search, filter, export, inspect and
 * enable or suspend a registered account; 3.2 says suspension takes effect at
 * once -- web sessions and API keys stop working and the account's libraries
 * stop answering. What that means concretely per subsystem is spelled out on
 * `setUserAccountStatus` below.
 *
 * Every sensitive action records the operator, the target, the values before
 * and after, the reason, the result, the time and a summary of the network
 * origin. `recordAudit` takes all of that; the caller here supplies it.
 */
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  AdminChangeRefused,
  normalizeReason,
  type UserAccountStatus,
} from '@/lib/domain/admin';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { listedInPublicChannel } from '@/lib/application/channels/visibility';
import { exposure } from '@/lib/application/channels/visibility';
import { subscriptionRenewal, type WorkspacePlanVersion } from '@/lib/application/plans/billing';
import { IN_FORCE_FIRST, subscriptionInForce } from '@/lib/application/plans/in-force';
import { recordAudit } from './audit';
import { startOfMonth } from './list-users';

export interface UserIdentity {
  provider: string;
  lastLoginAt: Date | null;
  createdAt: Date;
}

export interface UserWorkspaceView {
  id: string;
  name: string;
  role: string;
  planName: string;
  monthlyCalls: number | null;
  periodEnd: Date | null;
  /** Renews or cancels at the period's end; null when no provider bills it. */
  renewal: WorkspacePlanVersion['renewal'];
}

export interface UserLibraryView {
  id: string;
  publicId: string;
  title: string;
  visibility: string;
  lifecycleStatus: string;
  storageBytes: number;
  createdAt: Date;
}

export interface UserApiKeyView {
  id: string;
  name: string;
  keyPrefix: string;
  lastFour: string;
  environment: string;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface UserSessionView {
  id: string;
  clientSummary: Record<string, string>;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface UserAuditView {
  id: string;
  action: string;
  administrator: string | null;
  reason: string | null;
  result: string;
  createdAt: Date;
}

export interface ConsoleUserDetail {
  id: string;
  email: string;
  displayName: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  identities: UserIdentity[];
  workspaces: UserWorkspaceView[];
  libraries: UserLibraryView[];
  apiKeys: UserApiKeyView[];
  sessions: UserSessionView[];
  audit: UserAuditView[];
  callsThisMonth: number;
  /**
   * Totals, counted in SQL over the whole account rather than over the
   * `DETAIL_LIMIT` rows the panels above show.
   *
   * The distinction is not cosmetic: `liveSessions` and the two beside it are
   * what the suspend dialog quotes back to the operator, and a number derived
   * from a truncated list would understate the change on exactly the screen
   * that exists to make it checkable.
   */
  liveSessions: number;
  sessionTotal: number;
  /** API keys that have not been revoked -- what suspending would cover. */
  liveApiKeys: number;
  apiKeyTotal: number;
  /** Published libraries -- what suspending would take out of circulation. */
  publishedLibraries: number;
  publicLibraries: number;
  libraryTotal: number;
  auditTotal: number;
}

/** How much history the detail screen shows. Deeper reading is the audit log. */
const DETAIL_LIMIT = 20;

/**
 * One account, with everything a suspension decision depends on.
 *
 * Returns null rather than throwing for an unknown id: the caller is a page,
 * and a hand-edited URL should render a 404, not a 500.
 */
export async function getConsoleUser(
  userId: string,
  now: Date = new Date(),
): Promise<ConsoleUserDetail | null> {
  if (!isUuid(userId)) return null;

  const database = db();
  const [account] = await database
    .select({
      id: schema.user.id,
      email: schema.user.email,
      displayName: schema.user.displayName,
      status: schema.user.status,
      createdAt: schema.user.createdAt,
      updatedAt: schema.user.updatedAt,
    })
    .from(schema.user)
    .where(eq(schema.user.id, userId))
    .limit(1);

  if (!account) return null;

  const memberships = await database
    .select({
      workspaceId: schema.workspace.id,
      name: schema.workspace.name,
      role: schema.workspaceMember.role,
    })
    .from(schema.workspaceMember)
    .innerJoin(schema.workspace, eq(schema.workspace.id, schema.workspaceMember.workspaceId))
    .where(eq(schema.workspaceMember.userId, userId));

  const workspaceIds = memberships.map((row) => row.workspaceId);

  /*
   * Everything below hangs off the workspaces, and an account with none (which
   * only happens if workspace creation failed half-way) would otherwise send
   * `inArray` an empty list -- valid SQL, but four pointless round trips.
   */
  const [
    subscriptions,
    libraries,
    apiKeys,
    sessions,
    usage,
    identities,
    audit,
    libraryCounts,
    apiKeyCounts,
    sessionCounts,
    auditCount,
  ] = await Promise.all([
    workspaceIds.length === 0
      ? []
      : database
          .select({
            workspaceId: schema.subscription.workspaceId,
            planName: schema.plan.name,
            monthlyCalls: schema.planVersion.monthlyCalls,
            periodEnd: schema.subscription.periodEnd,
            providerSubscriptionId: schema.subscription.providerSubscriptionId,
            cancelAt: schema.subscription.cancelAt,
          })
          .from(schema.subscription)
          .innerJoin(
            schema.planVersion,
            eq(schema.planVersion.id, schema.subscription.planVersionId),
          )
          .innerJoin(schema.plan, eq(schema.plan.id, schema.planVersion.planId))
          /*
           * The rule billing and the quota use, not "any active row": a Pro
           * workspace also has the Free row signup wrote, and which of the two
           * this page showed used to depend on row order.
           */
          .where(
            and(inArray(schema.subscription.workspaceId, workspaceIds), subscriptionInForce()),
          )
          .orderBy(...IN_FORCE_FIRST),
    workspaceIds.length === 0
      ? []
      : database
          .select({
            id: schema.library.id,
            publicId: schema.library.publicId,
            title: schema.library.title,
            visibility: exposure(),
            lifecycleStatus: schema.library.lifecycleStatus,
            storageBytes: schema.library.storageBytes,
            createdAt: schema.library.createdAt,
          })
          .from(schema.library)
          .where(
            and(
              inArray(schema.library.ownerWorkspaceId, workspaceIds),
              isNull(schema.library.deletedAt),
            ),
          )
          .orderBy(desc(schema.library.createdAt))
          .limit(DETAIL_LIMIT),
    workspaceIds.length === 0
      ? []
      : database
          .select({
            id: schema.apiKey.id,
            name: schema.apiKey.name,
            keyPrefix: schema.apiKey.keyPrefix,
            lastFour: schema.apiKey.lastFour,
            environment: schema.apiKey.environment,
            lastUsedAt: schema.apiKey.lastUsedAt,
            revokedAt: schema.apiKey.revokedAt,
            createdAt: schema.apiKey.createdAt,
          })
          .from(schema.apiKey)
          .where(inArray(schema.apiKey.workspaceId, workspaceIds))
          .orderBy(desc(schema.apiKey.createdAt))
          .limit(DETAIL_LIMIT),
    database
      .select({
        id: schema.userSession.id,
        clientSummary: schema.userSession.clientSummary,
        lastSeenAt: schema.userSession.lastSeenAt,
        expiresAt: schema.userSession.expiresAt,
        revokedAt: schema.userSession.revokedAt,
      })
      .from(schema.userSession)
      .where(eq(schema.userSession.userId, userId))
      .orderBy(desc(schema.userSession.lastSeenAt))
      .limit(DETAIL_LIMIT),
    workspaceIds.length === 0
      ? []
      : database
          .select({ calls: sql<number>`coalesce(sum(${schema.usageSummary.calls}), 0)::int` })
          .from(schema.usageSummary)
          .where(
            and(
              inArray(schema.usageSummary.workspaceId, workspaceIds),
              sql`${schema.usageSummary.bucketDate} >= ${startOfMonth(now)}`,
            ),
          ),
    database
      .select({
        provider: schema.oauthAccount.provider,
        lastLoginAt: schema.oauthAccount.lastLoginAt,
        createdAt: schema.oauthAccount.createdAt,
      })
      .from(schema.oauthAccount)
      .where(eq(schema.oauthAccount.userId, userId))
      .orderBy(schema.oauthAccount.createdAt),
    database
      .select({
        id: schema.auditLog.id,
        action: schema.auditLog.action,
        reason: schema.auditLog.reason,
        result: schema.auditLog.result,
        createdAt: schema.auditLog.createdAt,
        administrator: schema.administrator.email,
      })
      .from(schema.auditLog)
      .leftJoin(
        schema.administrator,
        eq(schema.administrator.id, schema.auditLog.administratorId),
      )
      .where(and(eq(schema.auditLog.targetType, 'user'), eq(schema.auditLog.targetId, userId)))
      .orderBy(desc(schema.auditLog.seq))
      .limit(DETAIL_LIMIT),

    /*
     * The totals, separate from the rows above because the rows are capped and
     * these must not be. One aggregate per table rather than one count per
     * figure: the filtered variants ride along on the same scan.
     */
    workspaceIds.length === 0
      ? []
      : database
          .select({
            total: sql<number>`count(*)::int`,
            published: sql<number>`(count(*) filter (where ${schema.library.lifecycleStatus} = 'published'))::int`,
            visible: sql<number>`(count(*) filter (where ${listedInPublicChannel()}))::int`,
          })
          .from(schema.library)
          .where(
            and(
              inArray(schema.library.ownerWorkspaceId, workspaceIds),
              isNull(schema.library.deletedAt),
            ),
          ),
    workspaceIds.length === 0
      ? []
      : database
          .select({
            total: sql<number>`count(*)::int`,
            live: sql<number>`(count(*) filter (where ${schema.apiKey.revokedAt} is null))::int`,
          })
          .from(schema.apiKey)
          .where(inArray(schema.apiKey.workspaceId, workspaceIds)),
    database
      .select({
        total: sql<number>`count(*)::int`,
        live: sql<number>`(count(*) filter (
          where ${schema.userSession.revokedAt} is null and ${schema.userSession.expiresAt} > ${now}
        ))::int`,
      })
      .from(schema.userSession)
      .where(eq(schema.userSession.userId, userId)),
    database
      .select({ total: sql<number>`count(*)::int` })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.targetType, 'user'), eq(schema.auditLog.targetId, userId))),
  ]);

  /* Ordered by IN_FORCE_FIRST, so the first row per workspace is the one in force. */
  const planByWorkspace = new Map<string, (typeof subscriptions)[number]>();
  for (const row of subscriptions) {
    if (!planByWorkspace.has(row.workspaceId)) planByWorkspace.set(row.workspaceId, row);
  }

  return {
    id: account.id,
    email: account.email,
    displayName: account.displayName ?? account.email.split('@')[0] ?? account.email,
    status: account.status,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    identities,
    workspaces: memberships.map((row) => {
      const plan = planByWorkspace.get(row.workspaceId);
      return {
        id: row.workspaceId,
        name: row.name,
        role: row.role,
        // No active subscription is Free by definition. requirement.md 4.1
        planName: plan?.planName ?? 'Free',
        monthlyCalls: plan?.monthlyCalls ?? null,
        periodEnd: plan?.periodEnd ?? null,
        renewal: plan ? subscriptionRenewal(plan) : null,
      };
    }),
    libraries,
    apiKeys,
    sessions,
    audit,
    callsThisMonth: usage[0]?.calls ?? 0,
    liveSessions: sessionCounts[0]?.live ?? 0,
    sessionTotal: sessionCounts[0]?.total ?? 0,
    liveApiKeys: apiKeyCounts[0]?.live ?? 0,
    apiKeyTotal: apiKeyCounts[0]?.total ?? 0,
    publishedLibraries: libraryCounts[0]?.published ?? 0,
    publicLibraries: libraryCounts[0]?.visible ?? 0,
    libraryTotal: libraryCounts[0]?.total ?? 0,
    auditTotal: auditCount[0]?.total ?? 0,
  };
}

/** Cheap guard so a junk path segment cannot reach Postgres as a bad uuid cast. */
function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export interface UserStatusChange {
  actor: { administratorId: string; email: string; clientAddress?: string | null };
  userId: string;
  status: UserAccountStatus;
  reason: string;
}

export interface UserStatusChangeResult {
  status: UserAccountStatus;
  /** Web sessions ended by this change, so the console can say what happened. */
  sessionsRevoked: number;
}

/**
 * Enable or suspend one registered account. requirement.md 5.3.
 *
 * What suspension actually costs the account, subsystem by subsystem:
 *
 * - Web sessions: revoked here, in the same transaction as the status change.
 *   `resolveSession` also refuses a non-active account, so a session created a
 *   millisecond later is dead too -- the revocation is what makes the existing
 *   ones stop at once rather than at expiry (requirement.md 3.2).
 * - API keys: the key rows are deliberately *not* revoked. Revoking is
 *   irreversible -- only the hash is stored, so a re-enabled account could
 *   never get its keys back and every integration would have to be rebuilt for
 *   what may turn out to be a mistaken suspension. The account check belongs at
 *   the point of use, where it is reversible; API-key authentication is not
 *   built yet (architecture.md 21, step 2 onwards).
 * - Libraries: same reasoning. Access pauses while the owner is suspended;
 *   `lifecycle_status` is a review state and requirement.md 6.2 forbids folding
 *   another meaning into it, so suspension must not rewrite it.
 *
 * The counts the console shows for keys and libraries therefore describe what
 * the suspension covers, not rows this function edits.
 */
export async function setUserAccountStatus(
  input: UserStatusChange,
): Promise<UserStatusChangeResult> {
  const reason = normalizeReason(input.reason);

  const database = db();
  const [target] = await database
    .select({
      id: schema.user.id,
      email: schema.user.email,
      status: schema.user.status,
    })
    .from(schema.user)
    .where(eq(schema.user.id, input.userId))
    .limit(1);

  if (!target) throw new AdminChangeRefused('not_found', 'no such user');

  const now = new Date();
  let sessionsRevoked = 0;

  await database.transaction(async (tx) => {
    await tx
      .update(schema.user)
      .set({ status: input.status, updatedAt: now })
      .where(eq(schema.user.id, target.id));

    if (input.status === 'suspended') {
      const revoked = await tx
        .update(schema.userSession)
        .set({ revokedAt: now })
        .where(
          and(eq(schema.userSession.userId, target.id), isNull(schema.userSession.revokedAt)),
        )
        .returning({ id: schema.userSession.id });
      sessionsRevoked = revoked.length;
    }
  });

  await recordAudit({
    administratorId: input.actor.administratorId,
    action: input.status === 'suspended' ? 'user.suspend' : 'user.enable',
    targetType: 'user',
    /*
     * The id, not the address: an OAuth login rewrites `email` on every sign
     * in, so an address recorded today may not name this account tomorrow. The
     * address goes in the values instead, where it is a snapshot rather than a
     * key.
     */
    targetId: target.id,
    reason,
    beforeValue: { status: target.status, email: target.email },
    afterValue: { status: input.status, email: target.email, sessionsRevoked },
    clientAddress: input.actor.clientAddress ?? null,
    result: 'success',
  });

  return { status: input.status, sessionsRevoked };
}

export interface UserRevocation {
  actor: { administratorId: string; email: string; clientAddress?: string | null };
  userId: string;
  /** The session or key, which must belong to that user or their workspaces. */
  targetId: string;
  reason: string;
}

/**
 * End one of an account's web sessions. requirement.md 5.3, 3.2.
 *
 * Narrower than a suspension: the account stays active and every other
 * session keeps working. The row is looked up by user as well as id, so a
 * session id pasted from another account's page cannot be revoked through
 * this one -- the target is the user, and the session is a detail of it.
 *
 * Already-revoked and expired sessions are refused as `not_found` rather
 * than silently re-stamped: an audit entry that says a session was ended
 * should mean one was.
 */
export async function revokeUserSession(input: UserRevocation): Promise<void> {
  const reason = normalizeReason(input.reason);
  if (!isUuid(input.userId) || !isUuid(input.targetId)) {
    throw new AdminChangeRefused('not_found', 'no such session');
  }

  const database = db();
  const now = new Date();
  const [session] = await database
    .select({
      id: schema.userSession.id,
      clientSummary: schema.userSession.clientSummary,
      expiresAt: schema.userSession.expiresAt,
      revokedAt: schema.userSession.revokedAt,
    })
    .from(schema.userSession)
    .where(and(eq(schema.userSession.id, input.targetId), eq(schema.userSession.userId, input.userId)))
    .limit(1);

  if (!session || session.revokedAt !== null || session.expiresAt.getTime() <= now.getTime()) {
    throw new AdminChangeRefused('not_found', 'no live session with that id for this user');
  }

  await database
    .update(schema.userSession)
    .set({ revokedAt: now })
    .where(and(eq(schema.userSession.id, session.id), isNull(schema.userSession.revokedAt)));

  await recordAudit({
    administratorId: input.actor.administratorId,
    action: 'user.revoke_session',
    targetType: 'user',
    targetId: input.userId,
    reason,
    beforeValue: { sessionId: session.id, client: session.clientSummary, revokedAt: null },
    afterValue: { sessionId: session.id, client: session.clientSummary, revokedAt: now.toISOString() },
    clientAddress: input.actor.clientAddress ?? null,
    result: 'success',
  });
}

/**
 * Revoke one of an account's API keys. requirement.md 5.3.
 *
 * Irreversible, which is why a suspension leaves keys alone
 * (`setUserAccountStatus`) and this exists separately: an operator who has a
 * specific leaked or abused key in front of them can end that one on purpose,
 * with the name and prefix recorded, while the rest of the integration keeps
 * working. The key must belong to a workspace the user is a member of.
 */
export async function revokeUserApiKey(input: UserRevocation): Promise<void> {
  const reason = normalizeReason(input.reason);
  if (!isUuid(input.userId) || !isUuid(input.targetId)) {
    throw new AdminChangeRefused('not_found', 'no such key');
  }

  const database = db();
  const now = new Date();
  const [key] = await database
    .select({
      id: schema.apiKey.id,
      name: schema.apiKey.name,
      keyPrefix: schema.apiKey.keyPrefix,
      lastFour: schema.apiKey.lastFour,
      environment: schema.apiKey.environment,
      workspaceId: schema.apiKey.workspaceId,
      revokedAt: schema.apiKey.revokedAt,
    })
    .from(schema.apiKey)
    .innerJoin(
      schema.workspaceMember,
      and(
        eq(schema.workspaceMember.workspaceId, schema.apiKey.workspaceId),
        eq(schema.workspaceMember.userId, input.userId),
      ),
    )
    .where(eq(schema.apiKey.id, input.targetId))
    .limit(1);

  if (!key || key.revokedAt !== null) {
    throw new AdminChangeRefused('not_found', 'no live key with that id for this user');
  }

  await database
    .update(schema.apiKey)
    .set({ revokedAt: now })
    .where(and(eq(schema.apiKey.id, key.id), isNull(schema.apiKey.revokedAt)));

  const snapshot = {
    keyId: key.id,
    name: key.name,
    key: `${key.keyPrefix}…${key.lastFour}`,
    environment: key.environment,
    workspaceId: key.workspaceId,
  };
  await recordAudit({
    administratorId: input.actor.administratorId,
    action: 'user.revoke_api_key',
    targetType: 'user',
    targetId: input.userId,
    reason,
    beforeValue: { ...snapshot, revokedAt: null },
    afterValue: { ...snapshot, revokedAt: now.toISOString() },
    clientAddress: input.actor.clientAddress ?? null,
    result: 'success',
  });
}
