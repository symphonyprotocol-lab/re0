/**
 * Use case: the registered users the console lists.
 *
 * Reads the real `user` table. The counts beside each account come from the
 * tables that own them -- libraries from `library`, calls from `usage_summary`
 * -- so an account with no activity reads zero rather than an invented number.
 */
import { and, count, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { IN_FORCE_FIRST, subscriptionInForce } from '@/lib/application/plans/in-force';
import { ref } from './column-ref';
import { likePattern } from './like-pattern';

export type UserStatusFilter = 'all' | 'active' | 'suspended';

export interface ConsoleUserRow {
  id: string;
  displayName: string;
  email: string;
  planName: string;
  libraries: number;
  callsThisMonth: number;
  joinedAt: Date;
  status: string;
  /**
   * What suspending this account would reach, present only when the caller
   * asked for it (`suspensionScope`).
   *
   * The screen asks, because the confirmation happens in the row: an operator
   * told they are about to end "their sessions" is being asked to confirm
   * something they cannot check, and fetching the numbers after the click
   * would put a spinner in front of the one dialog that has to be exact. The
   * CSV export does not ask, because three more correlated counts across a
   * ten-thousand-row extract buy nothing a spreadsheet wanted.
   */
  liveSessions?: number;
  liveApiKeys?: number;
  publishedLibraries?: number;
}

export interface UserListInput {
  query?: string;
  status?: UserStatusFilter;
  limit?: number;
  /** Rows to skip, so the console's page controls are real navigation. */
  offset?: number;
  /** Also count what a suspension would reach. See `ConsoleUserRow`. */
  suspensionScope?: boolean;
}

export async function listConsoleUsers(input: UserListInput = {}): Promise<{
  rows: ConsoleUserRow[];
  total: number;
}> {
  const database = db();
  const term = input.query?.trim();
  const now = new Date();
  const monthStart = startOfMonth(now);

  const conditions = [
    term
      ? or(ilike(schema.user.displayName, likePattern(term)), ilike(schema.user.email, likePattern(term)))
      : undefined,
    /*
     * Only the two recognised values filter; anything else -- the export route
     * casts `?status=` rather than parsing it -- means "all", so a typo'd
     * filter widens the extract instead of silently exporting only suspended
     * accounts.
     */
    input.status === 'active' || input.status === 'suspended'
      ? eq(schema.user.status, input.status)
      : undefined,
  ].filter(Boolean);
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [totalRow] = await database
    .select({ n: count() })
    .from(schema.user)
    .where(where);

  /*
   * Everything per-account is a correlated subquery rather than a join. Two
   * joins at once would multiply rows against each other and inflate both
   * counts, and even a single join to `workspace_member` breaks the page: an
   * account with two memberships would occupy two of the page's rows and
   * render twice, while `total` -- which counts `user` -- still counts it once,
   * so the last page would silently drop accounts.
   *
   * Every column in them is reached through `ref` rather than embedded
   * directly, so each subquery keeps referring to the outer account row.
   */
  const userId = ref(schema.user.id);
  const libraryWorkspace = ref(schema.library.ownerWorkspaceId);

  const planName = sql<string | null>`(
    select p.name from ${schema.subscription}
    join ${schema.planVersion} pv on pv.id = ${ref(schema.subscription.planVersionId)}
    join ${schema.plan} p on p.id = pv.plan_id
    join ${schema.workspaceMember} wm on wm.workspace_id = ${ref(schema.subscription.workspaceId)}
    where wm.user_id = ${userId} and ${subscriptionInForce()}
    order by ${sql.join([...IN_FORCE_FIRST], sql`, `)}
    limit 1
  )`;
  const libraryCount = sql<number>`(
    select count(*)::int from ${schema.library}
    join ${schema.workspaceMember} wm on wm.workspace_id = ${libraryWorkspace}
    where wm.user_id = ${userId} and ${ref(schema.library.deletedAt)} is null
  )`;
  const callsThisMonth = sql<number>`(
    select coalesce(sum(${ref(schema.usageSummary.calls)}), 0)::int from ${schema.usageSummary}
    join ${schema.workspaceMember} wm on wm.workspace_id = ${ref(schema.usageSummary.workspaceId)}
    where wm.user_id = ${userId} and ${ref(schema.usageSummary.bucketDate)} >= ${monthStart}
  )`;
  const zero = sql<number>`0`;
  const liveSessions = !input.suspensionScope ? zero : sql<number>`(
    select count(*)::int from ${schema.userSession}
    where ${ref(schema.userSession.userId)} = ${userId}
      and ${ref(schema.userSession.revokedAt)} is null
      and ${ref(schema.userSession.expiresAt)} > ${now}
  )`;
  const liveApiKeys = !input.suspensionScope ? zero : sql<number>`(
    select count(*)::int from ${schema.apiKey}
    join ${schema.workspaceMember} wm on wm.workspace_id = ${ref(schema.apiKey.workspaceId)}
    where wm.user_id = ${userId} and ${ref(schema.apiKey.revokedAt)} is null
  )`;
  const publishedLibraries = !input.suspensionScope ? zero : sql<number>`(
    select count(*)::int from ${schema.library}
    join ${schema.workspaceMember} wm on wm.workspace_id = ${libraryWorkspace}
    where wm.user_id = ${userId} and ${ref(schema.library.lifecycleStatus)} = 'published'
      and ${ref(schema.library.deletedAt)} is null
  )`;

  const rows = await database
    .select({
      id: schema.user.id,
      displayName: schema.user.displayName,
      email: schema.user.email,
      status: schema.user.status,
      joinedAt: schema.user.createdAt,
      planName,
      libraries: libraryCount,
      callsThisMonth,
      liveSessions,
      liveApiKeys,
      publishedLibraries,
    })
    .from(schema.user)
    .where(where)
    /*
     * `created_at` alone is not a total order -- two accounts made in the same
     * transaction share it, and Postgres is then free to return them in either
     * order on either page, which loses one row and repeats another. The id
     * breaks the tie, so paging is stable.
     */
    .orderBy(desc(schema.user.createdAt), desc(schema.user.id))
    .limit(input.limit ?? 50)
    .offset(input.offset ?? 0);

  return {
    total: totalRow?.n ?? 0,
    rows: rows.map((row) => ({
      id: row.id,
      displayName: row.displayName ?? row.email.split('@')[0] ?? row.email,
      email: row.email,
      // No active subscription is Free by definition. requirement.md 4.1
      planName: row.planName ?? 'Free',
      libraries: row.libraries ?? 0,
      callsThisMonth: row.callsThisMonth ?? 0,
      joinedAt: row.joinedAt,
      status: row.status,
      ...(input.suspensionScope
        ? {
            liveSessions: row.liveSessions ?? 0,
            liveApiKeys: row.liveApiKeys ?? 0,
            publishedLibraries: row.publishedLibraries ?? 0,
          }
        : {}),
    })),
  };
}

export function startOfMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
