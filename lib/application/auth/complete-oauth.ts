/**
 * Use case: finish a login.
 *
 * Verifies the handshake, exchanges the code for a profile, and lands the
 * account in one transaction. First login creates user, personal workspace,
 * owner membership and a Free subscription together -- requirement.md 14.1
 * treats that as a single acceptance point, so it must not be able to half
 * happen.
 */
import { and, eq } from 'drizzle-orm';
import {
  AuthFailure,
  firstBillingPeriod,
  isAccountUsable,
  personalWorkspaceName,
  sessionExpiryFrom,
  type IdentityProfile,
  type IdentityProvider,
  type WorkspaceNaming,
} from '@/lib/domain/auth';
import { uuidv7 } from '@/lib/domain/id';
import { unseal } from '@/lib/infrastructure/crypto/sealed';
import { randomToken, timingSafeEqual } from '@/lib/infrastructure/crypto/tokens';
import { identityAdapter, type IdentityAdapter } from '@/lib/infrastructure/identity/oauth';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { freeHandleFor } from '@/lib/application/workspaces/handle';
import { isHandshakeShape, type Handshake } from '@/lib/application/auth/handshake';
import { sessionTokenHash } from '@/lib/application/auth/session-token';
import { PLAN_VERSION_NEWEST_FIRST } from '@/lib/application/plans';

export interface CompleteOAuthInput {
  provider: IdentityProvider;
  code: string | null;
  state: string | null;
  /** Whatever was in the handshake cookie, still sealed. */
  sealedHandshake: string | null | undefined;
  redirectUri: string;
  /** Coarse client fingerprint. Never an IP -- architecture.md 11.2. */
  clientSummary?: Record<string, string>;
  /**
   * Wording for the personal workspace created on first login, in the language
   * the visitor arrived in. The name is stored, so it is chosen once, here.
   */
  workspaceNaming: WorkspaceNaming;
  now?: Date;
  /** Seam for tests; production always uses the configured adapter. */
  adapter?: IdentityAdapter;
}

export interface CompleteOAuthResult {
  sessionToken: string;
  expiresAt: Date;
  returnTo: string;
}

function verifyHandshake(
  handshake: Handshake | null,
  input: CompleteOAuthInput,
  now: Date,
): Handshake {
  if (!handshake || !isHandshakeShape(handshake)) {
    throw new AuthFailure('oauth_failed', 'missing or unreadable handshake cookie');
  }
  if (handshake.expiresAt <= now.getTime()) {
    throw new AuthFailure('oauth_failed', 'handshake expired');
  }
  if (handshake.provider !== input.provider) {
    throw new AuthFailure('oauth_failed', 'handshake provider does not match the callback');
  }
  if (!input.state || !timingSafeEqual(handshake.state, input.state)) {
    throw new AuthFailure('oauth_failed', 'state mismatch');
  }
  if (!input.code) {
    throw new AuthFailure('oauth_failed', 'callback carried no code');
  }
  return handshake;
}

export async function completeOAuth(input: CompleteOAuthInput): Promise<CompleteOAuthResult> {
  const now = input.now ?? new Date();
  const handshake = verifyHandshake(
    await unseal<Handshake>(input.sealedHandshake),
    input,
    now,
  );

  const profile = await (input.adapter ?? identityAdapter()).exchange({
    provider: input.provider,
    code: input.code as string,
    codeVerifier: handshake.codeVerifier,
    nonce: handshake.nonce,
    redirectUri: input.redirectUri,
  });

  const sessionToken = randomToken();
  const expiresAt = sessionExpiryFrom(now);
  const tokenHash = await sessionTokenHash(sessionToken);

  await db().transaction(async (tx) => {
    const userId = await resolveUser(tx, profile, now);
    await ensurePersonalWorkspace(tx, userId, profile, input.workspaceNaming, now);

    await tx.insert(schema.userSession).values({
      id: uuidv7(now.getTime()),
      userId,
      tokenHash,
      clientSummary: input.clientSummary ?? {},
      lastSeenAt: now,
      expiresAt,
      createdAt: now,
    });
  });

  return { sessionToken, expiresAt, returnTo: handshake.returnTo };
}

type Tx = Parameters<Parameters<ReturnType<typeof db>['transaction']>[0]>[0];

/**
 * Finds the account behind the provider subject, or creates one.
 *
 * Matching is on `(provider, subject)` only. A second provider reporting an
 * address we have already seen does not join the accounts: requirement.md 3.2
 * bars automatic merging, and linking has to start from an existing session.
 */
async function resolveUser(tx: Tx, profile: IdentityProfile, now: Date): Promise<string> {
  const [existing] = await tx
    .select({ id: schema.oauthAccount.id, userId: schema.oauthAccount.userId })
    .from(schema.oauthAccount)
    .where(
      and(
        eq(schema.oauthAccount.provider, profile.provider),
        eq(schema.oauthAccount.providerSubject, profile.subject),
      ),
    )
    .limit(1);

  if (existing) {
    const [account] = await tx
      .select({ status: schema.user.status })
      .from(schema.user)
      .where(eq(schema.user.id, existing.userId))
      .limit(1);

    // requirement.md 3.2: a suspended account cannot come back through a login.
    if (!account || !isAccountUsable(account.status)) {
      throw new AuthFailure('account_disabled', 'account is not active');
    }

    await tx
      .update(schema.user)
      .set({
        email: profile.email,
        displayName: profile.displayName,
        avatarUrl: profile.avatarUrl,
        updatedAt: now,
      })
      .where(eq(schema.user.id, existing.userId));

    await tx
      .update(schema.oauthAccount)
      .set({ lastLoginAt: now })
      .where(eq(schema.oauthAccount.id, existing.id));

    return existing.userId;
  }

  const userId = uuidv7(now.getTime());
  await tx.insert(schema.user).values({
    id: userId,
    email: profile.email,
    displayName: profile.displayName,
    avatarUrl: profile.avatarUrl,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });
  await tx.insert(schema.oauthAccount).values({
    id: uuidv7(now.getTime()),
    userId,
    provider: profile.provider,
    providerSubject: profile.subject,
    lastLoginAt: now,
    createdAt: now,
  });
  return userId;
}

/**
 * Every account owns exactly one personal workspace on a Free subscription.
 *
 * Also runs for existing accounts: it is the repair path if a workspace ever
 * went missing, and it is cheap (one indexed read) on the normal login.
 */
async function ensurePersonalWorkspace(
  tx: Tx,
  userId: string,
  profile: IdentityProfile,
  naming: WorkspaceNaming,
  now: Date,
): Promise<void> {
  const [membership] = await tx
    .select({ workspaceId: schema.workspaceMember.workspaceId })
    .from(schema.workspaceMember)
    .where(eq(schema.workspaceMember.userId, userId))
    .limit(1);
  if (membership) return;

  const workspaceId = uuidv7(now.getTime());
  await tx.insert(schema.workspace).values({
    id: workspaceId,
    name: personalWorkspaceName(profile, naming),
    kind: 'personal',
    /* The public name for `/u/{handle}` and the user card (agent-first-
       proposal.md 12); the owner can change it from settings. */
    handle: await freeHandleFor(tx, profile.email, workspaceId),
    createdAt: now,
  });
  await tx.insert(schema.workspaceMember).values({
    workspaceId,
    userId,
    role: 'owner',
    createdAt: now,
  });

  /*
   * The same ordering the console calls "live", imported rather than repeated.
   * This used to carry its own `created_at DESC` with no tiebreak, which was
   * harmless while the seed guaranteed exactly one Free version -- but the plan
   * screen mints them now, and two rows written in one transaction share a
   * `now()`. A tie would have let signup bind an account to a version the
   * console does not show as live, quietly selling it a different allowance.
   */
  const [freePlan] = await tx
    .select({ id: schema.planVersion.id })
    .from(schema.planVersion)
    .where(eq(schema.planVersion.planId, 'free'))
    .orderBy(...PLAN_VERSION_NEWEST_FIRST)
    .limit(1);

  // The Free plan version is seeded by migration; without it a new account
  // would have no quota at all, so fail the login rather than half create it.
  if (!freePlan) throw new Error('no Free plan version is seeded');

  const period = firstBillingPeriod(now);
  await tx.insert(schema.subscription).values({
    id: uuidv7(now.getTime()),
    workspaceId,
    planVersionId: freePlan.id,
    status: 'active',
    periodStart: period.start,
    periodEnd: period.end,
  });
}
