/**
 * Use case: turn a session cookie into the caller's identity.
 *
 * Step 1 and 2 of the authorization order in architecture.md 5.2 (resolve the
 * session, then check user and workspace state). Always reads the primary --
 * permission state must not come from a replica (architecture.md 16).
 */
import { and, asc, eq } from 'drizzle-orm';
import {
  isAccountUsable,
  isSessionLive,
  sessionExpiryFrom,
  shouldTouchSession,
  workspaceInitial,
} from '@/lib/domain/auth';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { workspacePlanVersion } from '@/lib/application/plans/billing';
import { IN_FORCE_FIRST, subscriptionInForce } from '@/lib/application/plans/in-force';
import { sessionTokenHash } from '@/lib/application/auth/session-token';

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface SessionWorkspace {
  id: string;
  name: string;
  /** Avatar monogram, as drawn in the design source. */
  initial: string;
  role: 'owner' | 'admin' | 'developer' | 'viewer';
  planId: string;
  planName: string;
  monthlyCalls: number;
}

export interface UserSession {
  id: string;
  user: SessionUser;
  workspace: SessionWorkspace;
  expiresAt: Date;
}

export async function resolveSession(
  token: string | null | undefined,
  now: Date = new Date(),
): Promise<UserSession | null> {
  if (!token) return null;

  const database = db();
  const [row] = await database
    .select({
      sessionId: schema.userSession.id,
      expiresAt: schema.userSession.expiresAt,
      lastSeenAt: schema.userSession.lastSeenAt,
      revokedAt: schema.userSession.revokedAt,
      userId: schema.user.id,
      email: schema.user.email,
      displayName: schema.user.displayName,
      avatarUrl: schema.user.avatarUrl,
      status: schema.user.status,
    })
    .from(schema.userSession)
    .innerJoin(schema.user, eq(schema.user.id, schema.userSession.userId))
    .where(eq(schema.userSession.tokenHash, await sessionTokenHash(token)))
    .limit(1);

  if (!row) return null;
  if (!isSessionLive(row, now)) return null;
  // requirement.md 3.2: suspending an account kills its web sessions at once.
  if (!isAccountUsable(row.status)) return null;

  const [workspace] = await database
    .select({
      id: schema.workspace.id,
      name: schema.workspace.name,
      role: schema.workspaceMember.role,
      planId: schema.plan.id,
      planName: schema.plan.name,
      monthlyCalls: schema.planVersion.monthlyCalls,
    })
    .from(schema.workspaceMember)
    .innerJoin(schema.workspace, eq(schema.workspace.id, schema.workspaceMember.workspaceId))
    /*
     * The same rule `workspacePlanVersion` (lib/application/plans/billing.ts)
     * and `planWindow` (lib/application/plans/quota.ts) apply: a subscription
     * sets the plan only while its own period contains now. `status = 'active'`
     * alone is not that rule -- a row whose period has lapsed but whose status
     * nobody has moved yet kept printing "Pro" in the sidebar and on the
     * settings screen while billing and the quota transaction had already
     * fallen back to Free, so the badge sat beside Free's price and Free's
     * allowance. Plan identity has one definition; this is it.
     */
    .leftJoin(
      schema.subscription,
      and(eq(schema.subscription.workspaceId, schema.workspace.id), subscriptionInForce()),
    )
    .leftJoin(schema.planVersion, eq(schema.planVersion.id, schema.subscription.planVersionId))
    .leftJoin(schema.plan, eq(schema.plan.id, schema.planVersion.planId))
    .where(eq(schema.workspaceMember.userId, row.userId))
    /* Oldest membership first, id as tiebreak: a user in several workspaces
       must land in the same one on every request. Between two subscriptions
       in force, the one billing picks, so the two never disagree. */
    .orderBy(
      asc(schema.workspaceMember.createdAt),
      asc(schema.workspaceMember.workspaceId),
      ...IN_FORCE_FIRST,
    )
    .limit(1);

  if (!workspace) return null;

  /*
   * No subscription decides this workspace's plan, so the plan is whatever
   * billing falls back to: the newest Free version, with Free's allowance.
   * Naming the tier here and leaving the allowance at zero printed "Free"
   * beside "0 calls" on the sidebar and the settings screen for every
   * workspace without a live subscription -- a lapsed one, or one whose Free
   * subscription row was never written -- while the quota transaction was
   * happily granting Free's thousand. One definition, so read it from the
   * one place that has it.
   */
  const fallback = workspace.planId === null ? await workspacePlanVersion(workspace.id) : null;

  /* Sliding expiry (lib/domain/auth.ts): a use inside the window moves it. */
  const expiresAt = shouldTouchSession(row, now) ? sessionExpiryFrom(now) : row.expiresAt;
  if (expiresAt !== row.expiresAt) {
    await database
      .update(schema.userSession)
      .set({ lastSeenAt: now, expiresAt })
      .where(eq(schema.userSession.id, row.sessionId));
  }

  return {
    id: row.sessionId,
    expiresAt,
    user: {
      id: row.userId,
      email: row.email,
      displayName: row.displayName ?? row.email.split('@')[0] ?? row.email,
      avatarUrl: row.avatarUrl,
    },
    workspace: {
      id: workspace.id,
      name: workspace.name,
      initial: workspaceInitial(workspace.name),
      role: workspace.role,
      planId: workspace.planId ?? fallback?.planId ?? 'free',
      planName: workspace.planName ?? fallback?.planName ?? 'Free',
      monthlyCalls: workspace.monthlyCalls ?? fallback?.monthlyCalls ?? 0,
    },
  };
}
