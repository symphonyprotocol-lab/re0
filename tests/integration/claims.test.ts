/**
 * The ownership claim, end to end against a real database. requirement.md 7.3.
 *
 * `tests/contract/claim-rules.test.ts` pins the pure rules; nothing there has
 * ever executed the SQL those rules ride on. What is under test here is the
 * part only Postgres can answer:
 *
 * - the challenge is stored as a hash and returned in plaintext exactly once,
 *   and the partial unique index -- not a read that could be stale -- is what
 *   makes "one pending claim per asset" true;
 * - a passing check writes `asset.owner_workspace_id` and `status='verified'`
 *   in one transaction, and a failing one writes neither;
 * - a claim on an owned asset records its evidence and stays `pending`
 *   (the dispute of 7.3.5), so the row and the returned view agree;
 * - releasing gives up a *claimed* asset and refuses a created one, which
 *   would otherwise leave a public asset nobody can manage;
 * - the console's two rulings rewrite the owner and leave an audit row naming
 *   the actor, the target and the values on both sides;
 * - the two read models answer for one workspace and never another's.
 *
 * The two outbound checks (DNS, well-known) and GitHub are stubbed: what they
 * do is `tests/contract`'s business, and their verdict is this file's input.
 *
 * Runs only when TEST_DATABASE_URL points at a disposable database.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { shareInPublicChannel, unshare } from '../fixtures/channels';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

process.env.DATABASE_URL = TEST_DATABASE_URL ?? 'postgres://unused';
process.env.SESSION_SIGNING_SECRET ??= 'test-secret-that-is-long-enough-000000';

/*
 * The verdict of the two outbound checks, and how many times one ran. The
 * count is how "an expired claim never re-runs the check" is asserted: the
 * observable difference between refusing before the check and refusing after
 * it is whether the network was touched.
 */
const outbound = vi.hoisted(() => ({
  outcome: 'matched' as 'matched' | 'not_found' | 'unreachable',
  calls: 0,
}));

vi.mock('@/lib/infrastructure/verification/challenge', () => ({
  checkDnsChallenge: async () => {
    outbound.calls += 1;
    return outbound.outcome;
  },
  checkWellKnownChallenge: async () => {
    outbound.calls += 1;
    return outbound.outcome;
  },
}));

/*
 * The claim limiters, replaced by a seam.
 *
 * Two reasons. The real one is in-process and shared across this file, so a
 * later test would fail for an earlier test's traffic. The interesting one is
 * `before`: `assertWithinClaimLimits` runs between `startClaim`'s "is another
 * claim pending" read and its insert, which is exactly the window the partial
 * unique index exists to close -- so a hook there is how the race is made
 * deterministic instead of hoped for.
 */
const limiter = vi.hoisted(() => ({ before: null as null | (() => Promise<void>) }));

vi.mock('@/lib/infrastructure/cache/strict-rate-limit', () => ({
  strictRateLimit: async () => {
    const hook = limiter.before;
    limiter.before = null;
    if (hook) await hook();
    return { allowed: true, remaining: 1, retryAfterSeconds: 0 };
  },
  resetStrictRateLimit: () => {},
}));

/** GitHub's answers, so the `github_permission` SQL runs without the network. */
const github = vi.hoisted(() => ({
  permissions: { admin: true } as { admin?: boolean; maintain?: boolean } | null,
  fullName: 'acme/docs',
  homepage: 'https://docs.example.test' as string | null,
}));

vi.mock('@/lib/infrastructure/identity/github', () => ({
  repositoryGrant: async () => ({
    id: 1,
    fullName: github.fullName,
    homepage: github.homepage,
    permissions: github.permissions,
  }),
  publicRepositoryHomepage: async () => github.homepage,
}));

const { startClaim } = await import('@/lib/application/claims/start');
const { verifyClaim } = await import('@/lib/application/claims/verify');
const { releaseOwnership } = await import('@/lib/application/claims/release');
const { claimDetail, revokeClaim, ruleDispute } = await import('@/lib/application/claims/admin');
const { claimForClaimant, listWorkspaceClaims, ownershipForAssets, publicClaimStatus } =
  await import('@/lib/application/claims/views');
const { listClaims } = await import('@/lib/application/administration/list-assets');
const { AppError } = await import('@/contracts/errors');
const { AdminChangeRefused } = await import('@/lib/domain/admin');
const { capabilitiesForRoles, roleAllows } = await import('@/lib/domain/admin');
const { CLAIM_ATTEMPT_LIMIT, CLAIM_TTL_MS, isDisputedClaim, isReleasableOwnership } = await import(
  '@/lib/domain/claim',
);
const { resetStrictRateLimit } = await import('@/lib/infrastructure/cache/strict-rate-limit');
const { sha256 } = await import('@/lib/infrastructure/crypto/tokens');
const { db, schema } = await import('@/lib/infrastructure/postgres/client');
const { uuidv7 } = await import('@/lib/domain/id');

const workspaces: string[] = [];
const assets: string[] = [];
const users: string[] = [];
const administrators: string[] = [];

let sequence = 0;
function unique(prefix: string): string {
  sequence += 1;
  return `${prefix}-${process.pid}-${Date.now()}-${sequence}`;
}

async function workspace(name = 'claim-test'): Promise<string> {
  const id = crypto.randomUUID();
  workspaces.push(id);
  await db().insert(schema.workspace).values({ id, name });
  return id;
}

async function administrator(): Promise<{ administratorId: string; email: string }> {
  const id = crypto.randomUUID();
  administrators.push(id);
  const email = `${unique('ops')}@example.test`;
  await db()
    .insert(schema.administrator)
    .values({ id, username: unique('ops'), email, status: 'active' });
  return { administratorId: id, email };
}

interface AssetOptions {
  ownerWorkspaceId?: string | null;
  sourceType?: 'github' | 'website' | 'notion' | 'markdown';
  location?: string;
  visibility?: 'public' | 'private';
  lifecycleStatus?: 'published' | 'archived';
  isPlatformAsset?: boolean;
}

async function asset(options: AssetOptions = {}): Promise<{ id: string; publicId: string }> {
  const id = crypto.randomUUID();
  assets.push(id);
  const publicId = `/claim-test/${unique('lib')}`;
  await db()
    .insert(schema.asset)
    .values({
      id,
      publicId,
      title: 'Claim Test Asset',
      ownerWorkspaceId: options.ownerWorkspaceId ?? null,
      isPlatformAsset: options.isPlatformAsset ?? false,
      kind: options.sourceType === 'github' ? 'github' : 'website',
      lifecycleStatus: options.lifecycleStatus ?? 'published',
      indexStatus: 'ready',
    });
  /* Claimable means listed in a public channel now (agent-first-proposal.md 6.2). */
  if ((options.visibility ?? 'public') === 'public' && !options.isPlatformAsset) await shareInPublicChannel(id);
  await db()
    .insert(schema.source)
    .values({
      id: crypto.randomUUID(),
      assetId: id,
      type: options.sourceType ?? 'website',
      location: options.location ?? 'https://docs.example.test/guide',
    });
  return { id, publicId };
}

async function claimRow(claimId: string) {
  const [row] = await db()
    .select()
    .from(schema.assetClaim)
    .where(eq(schema.assetClaim.id, claimId));
  return row;
}

async function ownerOf(assetId: string): Promise<string | null> {
  const [row] = await db()
    .select({ ownerWorkspaceId: schema.asset.ownerWorkspaceId })
    .from(schema.asset)
    .where(eq(schema.asset.id, assetId));
  return row?.ownerWorkspaceId ?? null;
}

async function auditFor(claimId: string) {
  return db()
    .select({
      action: schema.auditLog.action,
      administratorId: schema.auditLog.administratorId,
      targetType: schema.auditLog.targetType,
      targetId: schema.auditLog.targetId,
      reason: schema.auditLog.reason,
      beforeValue: schema.auditLog.beforeValue,
      afterValue: schema.auditLog.afterValue,
      result: schema.auditLog.result,
    })
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.targetType, 'library_claim'), eq(schema.auditLog.targetId, claimId)))
    .orderBy(schema.auditLog.seq);
}

/** The refusal an operation answers with, as a code, so a pass is visible too. */
async function refusalOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'accepted';
  } catch (error) {
    if (error instanceof AppError) {
      return error.reason ? `${error.code}:${error.reason}` : error.code;
    }
    if (error instanceof AdminChangeRefused) return error.code;
    return `unexpected:${String(error)}`;
  }
}

/** A verified claim for `workspaceId` on a fresh asset, the honest way. */
async function claimed(options: AssetOptions = {}): Promise<{
  workspaceId: string;
  assetId: string;
  publicId: string;
  claimId: string;
}> {
  const workspaceId = await workspace('owner-ws');
  const target = await asset(options);
  const started = await startClaim({
    workspaceId,
    role: 'owner',
    assetPublicId: target.publicId,
    method: 'dns_txt',
  });
  outbound.outcome = 'matched';
  await verifyClaim({ claimId: started.claimId, workspaceId, role: 'owner' });
  return { workspaceId, assetId: target.id, publicId: target.publicId, claimId: started.claimId };
}

describeWithDb('ownership claims', () => {
  beforeEach(() => {
    /* The claim limiters are in-process here; a shared window across tests
       would make a later test fail for an earlier test's traffic. */
    resetStrictRateLimit();
    outbound.outcome = 'matched';
    outbound.calls = 0;
    github.permissions = { admin: true };
    github.fullName = 'acme/docs';
    github.homepage = 'https://docs.example.test';
  });

  afterAll(async () => {
    const database = db();
    if (assets.length > 0) {
      const claimIds = (
        await database
          .select({ id: schema.assetClaim.id })
          .from(schema.assetClaim)
          .where(inArray(schema.assetClaim.assetId, assets))
      ).map((row) => row.id);
      if (claimIds.length > 0) {
        await database
          .delete(schema.auditLog)
          .where(
            and(
              eq(schema.auditLog.targetType, 'library_claim'),
              inArray(schema.auditLog.targetId, claimIds),
            ),
          );
      }
      await database.delete(schema.assetClaim).where(inArray(schema.assetClaim.assetId, assets));
      await database.delete(schema.source).where(inArray(schema.source.assetId, assets));
      await database.update(schema.asset).set({ ownerWorkspaceId: null }).where(inArray(schema.asset.id, assets));
      await database.delete(schema.asset).where(inArray(schema.asset.id, assets));
    }
    if (users.length > 0) {
      await database.delete(schema.oauthAccount).where(inArray(schema.oauthAccount.userId, users));
      await database.delete(schema.workspaceMember).where(inArray(schema.workspaceMember.userId, users));
      await database.delete(schema.user).where(inArray(schema.user.id, users));
    }
    if (workspaces.length > 0) {
      await database.delete(schema.workspace).where(inArray(schema.workspace.id, workspaces));
    }
    if (administrators.length > 0) {
      await database
        .delete(schema.auditLog)
        .where(inArray(schema.auditLog.administratorId, administrators));
      await database.delete(schema.administrator).where(inArray(schema.administrator.id, administrators));
    }
  });

  /* ------------------------------------------------------------- startClaim */

  describe('startClaim', () => {
    it('mints one challenge, stores only its hash and sets the seven-day expiry', async () => {
      const workspaceId = await workspace();
      const target = await asset();
      const now = new Date('2026-03-01T00:00:00.000Z');

      const started = await startClaim({
        workspaceId,
        role: 'owner',
        assetPublicId: target.publicId,
        method: 'dns_txt',
        now,
      });

      expect(started.status).toBe('pending');
      expect(started.disputed).toBe(false);
      expect(started.challengeToken).toBeTruthy();
      expect(started.dnsRecordName).toBe('_re0-challenge.docs.example.test');

      const row = await claimRow(started.claimId);
      expect(row?.assetId).toBe(target.id);
      expect(row?.claimantWorkspaceId).toBe(workspaceId);
      expect(row?.method).toBe('dns_txt');
      expect(row?.status).toBe('pending');
      expect(row?.attempts).toBe(0);
      /* The plaintext is nowhere in the row; only its digest is. */
      expect(row?.challengeTokenHash).toBe(await sha256(started.challengeToken!));
      expect(row?.challengeTokenHash).not.toBe(started.challengeToken);
      expect(row?.expiresAt.getTime()).toBe(now.getTime() + CLAIM_TTL_MS);

      /* Returned once: the row cannot produce it again. */
      const reread = await claimForClaimant(workspaceId, started.claimId);
      expect(Object.values(reread)).not.toContain(started.challengeToken);
    });

    it('lets exactly one pending claim exist per asset, and the index is what says so', async () => {
      const first = await workspace('first');
      const second = await workspace('second');
      const target = await asset();

      const opened = await startClaim({
        workspaceId: first,
        role: 'owner',
        assetPublicId: target.publicId,
        method: 'dns_txt',
      });

      expect(
        await refusalOf(
          startClaim({
            workspaceId: second,
            role: 'owner',
            assetPublicId: target.publicId,
            method: 'dns_txt',
          }),
        ),
      ).toBe('claim_verification_failed:claim_in_progress');

      /* The same claimant is refused as "yours is still open". */
      expect(
        await refusalOf(
          startClaim({
            workspaceId: first,
            role: 'owner',
            assetPublicId: target.publicId,
            method: 'well_known',
          }),
        ),
      ).toBe('claim_verification_failed:claim_in_progress');

      const pending = await db()
        .select({ id: schema.assetClaim.id })
        .from(schema.assetClaim)
        .where(
          and(eq(schema.assetClaim.assetId, target.id), eq(schema.assetClaim.status, 'pending')),
        );
      expect(pending.map((row) => row.id)).toEqual([opened.claimId]);
    });

    it('settles a genuine race in Postgres, not in the read that precedes it', async () => {
      const first = await workspace('first');
      const second = await workspace('second');
      const target = await asset();

      /*
       * `first` passes the "nothing pending" read, and `second`'s claim lands
       * before its insert does. The unique index is the only thing left to
       * refuse it, and the refusal must reach the caller as the same
       * `claim_in_progress` the read would have given.
       */
      let raced: string | null = null;
      limiter.before = async () => {
        raced = uuidv7();
        await db().insert(schema.assetClaim).values({
          id: raced,
          assetId: target.id,
          claimantWorkspaceId: second,
          method: 'well_known',
          challengeTokenHash: 'x'.repeat(64),
          status: 'pending',
          attempts: 0,
          expiresAt: new Date(Date.now() + CLAIM_TTL_MS),
        });
      };

      expect(
        await refusalOf(
          startClaim({
            workspaceId: first,
            role: 'owner',
            assetPublicId: target.publicId,
            method: 'dns_txt',
          }),
        ),
      ).toBe('claim_verification_failed:claim_in_progress');

      /* The loser wrote nothing: one pending claim, and it is the winner's. */
      const survivors = await db()
        .select({ id: schema.assetClaim.id })
        .from(schema.assetClaim)
        .where(eq(schema.assetClaim.assetId, target.id));
      expect(survivors.map((row) => row.id)).toEqual([raced]);
    });

    it('answers for an invisible asset exactly as for one that does not exist', async () => {
      const workspaceId = await workspace();
      const absent = '/claim-test/no-such-asset';
      const hidden = await Promise.all([
        asset({ visibility: 'private' }),
        asset({ lifecycleStatus: 'archived' }),
        asset({ isPlatformAsset: true }),
        /* A source with no claim flow is not a claimable asset either. */
        asset({ sourceType: 'notion', location: 'https://www.notion.so/page' }),
      ]);

      const answers = await Promise.all(
        [absent, ...hidden.map((row) => row.publicId)].map((publicId) =>
          refusalOf(startClaim({ workspaceId, role: 'owner', assetPublicId: publicId, method: 'dns_txt' })),
        ),
      );
      expect(answers).toEqual(Array(answers.length).fill('asset_not_found'));
    });

    it('refuses a method the source type does not offer', async () => {
      const workspaceId = await workspace();
      const target = await asset({ sourceType: 'website' });
      expect(
        await refusalOf(
          startClaim({
            workspaceId,
            role: 'owner',
            assetPublicId: target.publicId,
            method: 'github_permission',
          }),
        ),
      ).toBe('claim_verification_failed:source_mismatch');
      expect(await claimsOn(target.id)).toHaveLength(0);
    });

    it('refuses a non-manager role before any row is written', async () => {
      const workspaceId = await workspace();
      const target = await asset();
      for (const role of ['viewer', 'developer'] as const) {
        expect(
          await refusalOf(
            startClaim({ workspaceId, role, assetPublicId: target.publicId, method: 'dns_txt' }),
          ),
        ).toBe('access_denied');
      }
      expect(await claimsOn(target.id)).toHaveLength(0);
    });

    it('refuses an asset this workspace already owns', async () => {
      const owned = await claimed();
      expect(
        await refusalOf(
          startClaim({
            workspaceId: owned.workspaceId,
            role: 'owner',
            assetPublicId: owned.publicId,
            method: 'dns_txt',
          }),
        ),
      ).toBe('claim_verification_failed:already_claimed');
    });
  });

  /* ------------------------------------------------------------ verifyClaim */

  describe('verifyClaim', () => {
    it('writes the owner and the verified status together', async () => {
      const workspaceId = await workspace();
      const target = await asset();
      const started = await startClaim({
        workspaceId,
        role: 'owner',
        assetPublicId: target.publicId,
        method: 'well_known',
      });

      outbound.outcome = 'matched';
      const result = await verifyClaim({ claimId: started.claimId, workspaceId, role: 'owner' });

      expect(result.status).toBe('verified');
      expect(result.disputed).toBe(false);
      expect(result.checks.every((check) => check.state === 'ok')).toBe(true);

      const row = await claimRow(started.claimId);
      expect(row?.status).toBe('verified');
      expect(row?.failureReason).toBeNull();
      expect(row?.verifiedAt).toBeInstanceOf(Date);
      expect(await ownerOf(target.id)).toBe(workspaceId);
    });

    it('leaves both the owner and the status alone when the check fails', async () => {
      const workspaceId = await workspace();
      const target = await asset();
      const started = await startClaim({
        workspaceId,
        role: 'owner',
        assetPublicId: target.publicId,
        method: 'dns_txt',
      });

      outbound.outcome = 'not_found';
      expect(await refusalOf(verifyClaim({ claimId: started.claimId, workspaceId, role: 'owner' }))).toBe(
        'claim_verification_failed:challenge_not_found',
      );

      const row = await claimRow(started.claimId);
      expect(row?.status).toBe('pending');
      expect(row?.failureReason).toBe('challenge_not_found');
      expect(row?.attempts).toBe(1);
      expect(row?.verifiedAt).toBeNull();
      expect(await ownerOf(target.id)).toBeNull();
    });

    it('locks the entry once the attempt limit is spent, and keeps it locked', async () => {
      const workspaceId = await workspace();
      const target = await asset();
      const started = await startClaim({
        workspaceId,
        role: 'owner',
        assetPublicId: target.publicId,
        method: 'dns_txt',
      });

      outbound.outcome = 'not_found';
      const codes: string[] = [];
      for (let attempt = 0; attempt < CLAIM_ATTEMPT_LIMIT; attempt += 1) {
        codes.push(await refusalOf(verifyClaim({ claimId: started.claimId, workspaceId, role: 'owner' })));
      }
      expect(codes.at(-1)).toBe('claim_verification_failed:retry_limit_exceeded');

      const row = await claimRow(started.claimId);
      expect(row?.status).toBe('failed');
      expect(row?.attempts).toBe(CLAIM_ATTEMPT_LIMIT);

      /* Past the limit the check no longer runs: the claim is terminal. */
      outbound.outcome = 'matched';
      const spent = outbound.calls;
      const after = await verifyClaim({ claimId: started.claimId, workspaceId, role: 'owner' });
      expect(after.status).toBe('failed');
      expect(outbound.calls).toBe(spent);
      expect(await ownerOf(target.id)).toBeNull();

      /* And a fresh claim is refused while the lock holds (7.3.7). */
      expect(
        await refusalOf(
          startClaim({
            workspaceId,
            role: 'owner',
            assetPublicId: target.publicId,
            method: 'dns_txt',
          }),
        ),
      ).toBe('claim_verification_failed:retry_limit_exceeded');
    });

    it('counts every failed check, even two that arrive together', async () => {
      const workspaceId = await workspace();
      const target = await asset();
      const started = await startClaim({
        workspaceId,
        role: 'owner',
        assetPublicId: target.publicId,
        method: 'dns_txt',
      });

      /*
       * 7.3.7 locks the entry on a count of failed checks, so the count is a
       * security control and not a statistic: two checks that fail at once
       * must spend two attempts, not one. A read-modify-write off the row
       * loaded before the check loses one of them.
       */
      outbound.outcome = 'not_found';
      const codes = await Promise.all([
        refusalOf(verifyClaim({ claimId: started.claimId, workspaceId, role: 'owner' })),
        refusalOf(verifyClaim({ claimId: started.claimId, workspaceId, role: 'owner' })),
      ]);
      expect(codes).toEqual([
        'claim_verification_failed:challenge_not_found',
        'claim_verification_failed:challenge_not_found',
      ]);
      expect((await claimRow(started.claimId))?.attempts).toBe(2);
    });

    it('marks an expired claim expired and never re-runs its check', async () => {
      const workspaceId = await workspace();
      const target = await asset();
      const started = await startClaim({
        workspaceId,
        role: 'owner',
        assetPublicId: target.publicId,
        method: 'dns_txt',
      });
      await db()
        .update(schema.assetClaim)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(schema.assetClaim.id, started.claimId));

      outbound.outcome = 'matched';
      const spent = outbound.calls;
      expect(await refusalOf(verifyClaim({ claimId: started.claimId, workspaceId, role: 'owner' }))).toBe(
        'claim_verification_failed:challenge_expired',
      );
      expect(outbound.calls).toBe(spent);

      const row = await claimRow(started.claimId);
      expect(row?.status).toBe('expired');
      expect(row?.failureReason).toBe('challenge_expired');
      expect(await ownerOf(target.id)).toBeNull();

      /* A second call reads the terminal row rather than expiring it again. */
      const again = await verifyClaim({ claimId: started.claimId, workspaceId, role: 'owner' });
      expect(again.status).toBe('expired');
      expect(outbound.calls).toBe(spent);
      expect((await auditFor(started.claimId)).filter((entry) => entry.action === 'claim.expire')).toHaveLength(1);
    });

    it('refuses a claim whose asset stopped being claimable after it opened', async () => {
      const workspaceId = await workspace();
      const privately = await asset();
      const archived = await asset();
      const opened = await Promise.all([
        startClaim({ workspaceId, role: 'owner', assetPublicId: privately.publicId, method: 'dns_txt' }),
        startClaim({ workspaceId, role: 'owner', assetPublicId: archived.publicId, method: 'dns_txt' }),
      ]);
      await unshare(privately.id);
      await db().update(schema.asset).set({ lifecycleStatus: 'archived' }).where(eq(schema.asset.id, archived.id));

      outbound.outcome = 'matched';
      for (const claim of opened) {
        expect(await refusalOf(verifyClaim({ claimId: claim.claimId, workspaceId, role: 'owner' }))).toBe(
          'asset_not_found',
        );
      }
      expect(await ownerOf(privately.id)).toBeNull();
      expect(await ownerOf(archived.id)).toBeNull();
    });

    it('records a dispute rather than an owner when the asset already has one', async () => {
      const incumbent = await claimed();
      const challenger = await workspace('challenger');
      const started = await startClaim({
        workspaceId: challenger,
        role: 'owner',
        assetPublicId: incumbent.publicId,
        method: 'dns_txt',
      });
      expect(started.disputed).toBe(true);

      outbound.outcome = 'matched';
      const result = await verifyClaim({ claimId: started.claimId, workspaceId: challenger, role: 'owner' });
      expect(result.disputed).toBe(true);
      expect(result.status).toBe('pending');

      const row = await claimRow(started.claimId);
      expect(row?.status).toBe('pending');
      expect(row?.failureReason).toBe('already_claimed');
      expect(row?.verifiedAt).toBeInstanceOf(Date);
      /* The incumbent is untouched: only a ruling moves ownership from here. */
      expect(await ownerOf(incumbent.assetId)).toBe(incumbent.workspaceId);
    });

    it('answers not found for another workspace and refuses a non-manager role', async () => {
      const workspaceId = await workspace();
      const stranger = await workspace('stranger');
      const target = await asset();
      const started = await startClaim({
        workspaceId,
        role: 'owner',
        assetPublicId: target.publicId,
        method: 'dns_txt',
      });

      expect(await refusalOf(verifyClaim({ claimId: started.claimId, workspaceId: stranger, role: 'owner' }))).toBe(
        'asset_not_found',
      );
      expect(await refusalOf(verifyClaim({ claimId: started.claimId, workspaceId, role: 'viewer' }))).toBe(
        'access_denied',
      );
      expect((await claimRow(started.claimId))?.attempts).toBe(0);
    });

    it('runs the GitHub permission check against the linked account', async () => {
      const workspaceId = await workspace();
      const target = await asset({ sourceType: 'github', location: 'acme/docs' });
      const userId = crypto.randomUUID();
      users.push(userId);
      await db().insert(schema.user).values({ id: userId, email: `${unique('dev')}@example.test` });
      await db()
        .insert(schema.oauthAccount)
        .values({ id: crypto.randomUUID(), userId, provider: 'github', providerSubject: 'gh-42' });

      const started = await startClaim({
        workspaceId,
        role: 'owner',
        assetPublicId: target.publicId,
        method: 'github_permission',
      });
      expect(started.challengeToken).toBeUndefined();

      /* A token whose GitHub account is not the linked one is not a link. */
      expect(
        await refusalOf(
          verifyClaim({
            claimId: started.claimId,
            workspaceId,
            role: 'owner',
            grant: { token: 'gho_x', subject: 'gh-99', userId },
          }),
        ),
      ).toBe('claim_verification_failed:account_not_linked');

      /* Linked, but only read access. */
      github.permissions = { admin: false, maintain: false };
      expect(
        await refusalOf(
          verifyClaim({
            claimId: started.claimId,
            workspaceId,
            role: 'owner',
            grant: { token: 'gho_x', subject: 'gh-42', userId },
          }),
        ),
      ).toBe('claim_verification_failed:insufficient_permission');

      github.permissions = { admin: true };
      const ok = await verifyClaim({
        claimId: started.claimId,
        workspaceId,
        role: 'owner',
        grant: { token: 'gho_x', subject: 'gh-42', userId },
      });
      expect(ok.status).toBe('verified');
      expect(await ownerOf(target.id)).toBe(workspaceId);
    });
  });

  /* ------------------------------------------------------- releaseOwnership */

  describe('releaseOwnership', () => {
    it('gives up a claimed asset and closes the claim that granted it', async () => {
      const owned = await claimed();

      const released = await releaseOwnership({
        workspaceId: owned.workspaceId,
        role: 'owner',
        assetId: owned.assetId,
      });
      expect(released.publicId).toBe(owned.publicId);
      expect(await ownerOf(owned.assetId)).toBeNull();

      const row = await claimRow(owned.claimId);
      expect(row?.status).toBe('revoked');
      expect(row?.rulingReason).toBe('released_by_owner');
    });

    it('refuses an asset the workspace merely created, so it cannot be stranded', async () => {
      const creator = await workspace('creator');
      const target = await asset({ ownerWorkspaceId: creator, sourceType: 'notion' });

      expect(
        await refusalOf(releaseOwnership({ workspaceId: creator, role: 'owner', assetId: target.id })),
      ).toBe('asset_not_found');
      /* The point of the refusal: the asset still has somebody who can manage it. */
      expect(await ownerOf(target.id)).toBe(creator);
    });

    it('refuses a non-manager role and an asset the workspace does not own', async () => {
      const owned = await claimed();
      const stranger = await workspace('stranger');

      expect(
        await refusalOf(releaseOwnership({ workspaceId: owned.workspaceId, role: 'viewer', assetId: owned.assetId })),
      ).toBe('access_denied');
      expect(
        await refusalOf(releaseOwnership({ workspaceId: stranger, role: 'owner', assetId: owned.assetId })),
      ).toBe('asset_not_found');
      expect(await ownerOf(owned.assetId)).toBe(owned.workspaceId);
    });
  });

  /* --------------------------------------------------------- console rulings */

  describe('ruleDispute and revokeClaim', () => {
    /**
     * A dispute: `incumbent` owns the asset through a verified claim, and
     * `challenger` has proven control of the same source.
     */
    async function dispute() {
      const incumbent = await claimed();
      const challenger = await workspace('challenger');
      const started = await startClaim({
        workspaceId: challenger,
        role: 'owner',
        assetPublicId: incumbent.publicId,
        method: 'dns_txt',
      });
      outbound.outcome = 'matched';
      await verifyClaim({ claimId: started.claimId, workspaceId: challenger, role: 'owner' });
      return { incumbent, challenger, claimId: started.claimId };
    }

    it('grants the asset to the challenger and closes the incumbent claim', async () => {
      const actor = await administrator();
      const { incumbent, challenger, claimId } = await dispute();

      const ruled = await ruleDispute({ actor, claimId, decision: 'grant', reason: 'rights document filed' });
      expect(ruled.status).toBe('verified');
      expect(ruled.ownerWorkspaceId).toBe(challenger);
      expect(await ownerOf(incumbent.assetId)).toBe(challenger);
      expect((await claimRow(claimId))?.status).toBe('verified');
      /* Two live claims on one asset would be a record nobody can read. */
      expect((await claimRow(incumbent.claimId))?.status).toBe('revoked');

      const audit = (await auditFor(claimId)).filter((entry) => entry.action === 'claim.transfer');
      expect(audit).toHaveLength(1);
      expect(audit[0]?.administratorId).toBe(actor.administratorId);
      expect(audit[0]?.targetType).toBe('library_claim');
      expect(audit[0]?.targetId).toBe(claimId);
      expect(audit[0]?.reason).toBe('rights document filed');
      expect(audit[0]?.result).toBe('success');
      expect(audit[0]?.beforeValue).toMatchObject({ status: 'pending', ownerWorkspaceId: incumbent.workspaceId });
      expect(audit[0]?.afterValue).toMatchObject({
        status: 'verified',
        ownerWorkspaceId: challenger,
        claimantWorkspaceId: challenger,
        administrator: actor.email,
      });
    });

    it('dismisses a dispute without touching the owner', async () => {
      const actor = await administrator();
      const { incumbent, challenger, claimId } = await dispute();

      const ruled = await ruleDispute({ actor, claimId, decision: 'dismiss', reason: 'evidence insufficient' });
      expect(ruled.status).toBe('failed');
      expect(ruled.ownerWorkspaceId).toBe(incumbent.workspaceId);
      expect(await ownerOf(incumbent.assetId)).toBe(incumbent.workspaceId);

      const row = await claimRow(claimId);
      expect(row?.status).toBe('failed');
      expect(row?.rulingAdminId).toBe(actor.administratorId);
      expect(row?.rulingReason).toBe('evidence insufficient');
      expect(row?.failureReason).toBe('already_claimed');

      const audit = (await auditFor(claimId)).filter((entry) => entry.action === 'claim.dismiss');
      expect(audit).toHaveLength(1);
      expect(audit[0]?.administratorId).toBe(actor.administratorId);
      expect(audit[0]?.beforeValue).toMatchObject({ ownerWorkspaceId: incumbent.workspaceId });
      expect(audit[0]?.afterValue).toMatchObject({ ownerWorkspaceId: incumbent.workspaceId, status: 'failed' });
      expect(challenger).toBeTruthy();
    });

    it('requires a reason, a real claim and an actual dispute', async () => {
      const actor = await administrator();
      const { claimId } = await dispute();

      expect(await refusalOf(ruleDispute({ actor, claimId, decision: 'grant', reason: '  ' }))).toBe('reason_required');
      expect(
        await refusalOf(ruleDispute({ actor, claimId: crypto.randomUUID(), decision: 'grant', reason: 'x' })),
      ).toBe('not_found');
      expect(await refusalOf(ruleDispute({ actor, claimId: 'junk', decision: 'grant', reason: 'x' }))).toBe('not_found');

      /* A pending claim on an unowned asset is the claimant's to prove. */
      const workspaceId = await workspace();
      const target = await asset();
      const plain = await startClaim({
        workspaceId,
        role: 'owner',
        assetPublicId: target.publicId,
        method: 'dns_txt',
      });
      expect(await refusalOf(ruleDispute({ actor, claimId: plain.claimId, decision: 'grant', reason: 'x' }))).toBe(
        'invalid_input',
      );
      expect(await ownerOf(target.id)).toBeNull();

      /* And nothing was written by the refusals above. */
      expect((await claimRow(claimId))?.status).toBe('pending');
      expect((await claimRow(claimId))?.rulingReason).toBeNull();
    });

    it('revokes a verified claim, clearing the owner with it', async () => {
      const actor = await administrator();
      const owned = await claimed();

      const revoked = await revokeClaim({ actor, claimId: owned.claimId, reason: 'source removed upstream' });
      expect(revoked.status).toBe('revoked');
      expect(revoked.ownerCleared).toBe(true);
      expect(await ownerOf(owned.assetId)).toBeNull();

      const row = await claimRow(owned.claimId);
      expect(row?.status).toBe('revoked');
      expect(row?.rulingAdminId).toBe(actor.administratorId);
      expect(row?.rulingReason).toBe('source removed upstream');

      const audit = (await auditFor(owned.claimId)).filter((entry) => entry.action === 'claim.revoke');
      expect(audit).toHaveLength(1);
      expect(audit[0]?.administratorId).toBe(actor.administratorId);
      expect(audit[0]?.reason).toBe('source removed upstream');
      expect(audit[0]?.beforeValue).toMatchObject({ status: 'verified', ownerWorkspaceId: owned.workspaceId });
      expect(audit[0]?.afterValue).toMatchObject({ status: 'revoked', ownerWorkspaceId: null });
    });

    it('revokes a pending claim, reopening the asset for a new one', async () => {
      const actor = await administrator();
      const workspaceId = await workspace();
      const target = await asset();
      const started = await startClaim({
        workspaceId,
        role: 'owner',
        assetPublicId: target.publicId,
        method: 'dns_txt',
      });

      const revoked = await revokeClaim({ actor, claimId: started.claimId, reason: 'abandoned' });
      expect(revoked.ownerCleared).toBe(false);
      expect(await ownerOf(target.id)).toBeNull();

      const next = await startClaim({
        workspaceId,
        role: 'owner',
        assetPublicId: target.publicId,
        method: 'dns_txt',
      });
      expect(next.claimId).not.toBe(started.claimId);
    });

    it('records the asset owner as it truly stood when a dispute is revoked', async () => {
      const actor = await administrator();
      const { incumbent, claimId } = await dispute();

      const revoked = await revokeClaim({ actor, claimId, reason: 'claimant withdrew' });
      expect(revoked.ownerCleared).toBe(false);
      /* Revoking the challenger's claim settles nothing about the owner. */
      expect(await ownerOf(incumbent.assetId)).toBe(incumbent.workspaceId);

      const audit = (await auditFor(claimId)).filter((entry) => entry.action === 'claim.revoke');
      expect(audit).toHaveLength(1);
      expect(audit[0]?.beforeValue).toMatchObject({
        status: 'pending',
        ownerWorkspaceId: incumbent.workspaceId,
      });
      expect(audit[0]?.afterValue).toMatchObject({
        status: 'revoked',
        ownerWorkspaceId: incumbent.workspaceId,
      });
    });

    it('requires a reason to revoke, and refuses a state that has nothing to revoke', async () => {
      const actor = await administrator();
      const owned = await claimed();

      expect(await refusalOf(revokeClaim({ actor, claimId: owned.claimId, reason: '' }))).toBe('reason_required');
      expect((await claimRow(owned.claimId))?.status).toBe('verified');

      await revokeClaim({ actor, claimId: owned.claimId, reason: 'first' });
      /* Revoked is terminal; a second revocation is not a transition. */
      expect(await refusalOf(revokeClaim({ actor, claimId: owned.claimId, reason: 'again' }))).toBe('invalid_input');
      expect((await claimRow(owned.claimId))?.rulingReason).toBe('first');
    });

    /**
     * The capability gate itself lives at the console's edge --
     * `requireAdminCapability('claims')` in app/admin/(console)/claims/actions.ts
     * -- and needs a request scope no integration test has. What this file can
     * pin is the rule that gate reads: ownership is the operator's, never the
     * reviewer's or support's.
     */
    it('puts both rulings behind the claims capability', () => {
      expect(roleAllows('super', 'claims')).toBe(true);
      expect(roleAllows('operator', 'claims')).toBe(true);
      expect(roleAllows('reviewer', 'claims')).toBe(false);
      expect(roleAllows('support', 'claims')).toBe(false);
      expect(capabilitiesForRoles(['reviewer', 'support'])).not.toContain('claims');
    });
  });

  /* ------------------------------------------------------------ read models */

  describe('listWorkspaceClaims and claimDetail', () => {
    it('answers for one workspace and never leaks another', async () => {
      const mine = await workspace('mine');
      const theirs = await workspace('theirs');
      const a = await asset();
      const b = await asset();

      const own = await startClaim({ workspaceId: mine, role: 'owner', assetPublicId: a.publicId, method: 'dns_txt' });
      const other = await startClaim({
        workspaceId: theirs,
        role: 'owner',
        assetPublicId: b.publicId,
        method: 'well_known',
      });

      const rows = await listWorkspaceClaims(mine);
      expect(rows.map((row) => row.id)).toContain(own.claimId);
      expect(rows.map((row) => row.id)).not.toContain(other.claimId);
      expect(rows.every((row) => row.assetPublicId !== b.publicId)).toBe(true);

      /* A claim id is not a capability: the other workspace's is not readable. */
      expect(await refusalOf(claimForClaimant(mine, other.claimId))).toBe('asset_not_found');
      expect(await refusalOf(claimForClaimant(mine, 'junk'))).toBe('asset_not_found');
    });

    it('marks the disputed rows exactly as isDisputedClaim does', async () => {
      const incumbent = await claimed();
      const challenger = await workspace('challenger');
      const disputed = await startClaim({
        workspaceId: challenger,
        role: 'owner',
        assetPublicId: incumbent.publicId,
        method: 'dns_txt',
      });
      const plainAsset = await asset();
      const plain = await startClaim({
        workspaceId: challenger,
        role: 'owner',
        assetPublicId: plainAsset.publicId,
        method: 'dns_txt',
      });

      const rows = await listWorkspaceClaims(challenger);
      for (const row of rows) {
        expect(row.disputed).toBe(
          isDisputedClaim({
            status: row.status,
            ownerWorkspaceId: row.id === disputed.claimId ? incumbent.workspaceId : null,
            claimantWorkspaceId: challenger,
          }),
        );
      }
      expect(rows.find((row) => row.id === disputed.claimId)?.disputed).toBe(true);
      expect(rows.find((row) => row.id === plain.claimId)?.disputed).toBe(false);

      /* The owner's own verified claim is settled, so it is not a dispute. */
      const owned = await listWorkspaceClaims(incumbent.workspaceId);
      expect(owned.find((row) => row.id === incumbent.claimId)?.disputed).toBe(false);

      /* The claimant's view and the console's agree on the same claim. */
      expect((await claimForClaimant(challenger, disputed.claimId)).disputed).toBe(true);
      expect((await claimDetail(disputed.claimId))?.disputed).toBe(true);
      expect((await claimDetail(incumbent.claimId))?.disputed).toBe(false);
      const queue = await listClaims({ status: 'disputed' });
      expect(queue.rows.map((row) => row.id)).toContain(disputed.claimId);
      expect(queue.rows.map((row) => row.id)).not.toContain(plain.claimId);
    });

    it('gives the console the claim with its parties, checks and audit trail', async () => {
      const actor = await administrator();
      const owned = await claimed();

      const detail = await claimDetail(owned.claimId);
      expect(detail?.status).toBe('verified');
      expect(detail?.claimant.id).toBe(owned.workspaceId);
      expect(detail?.currentOwner?.id).toBe(owned.workspaceId);
      expect(detail?.asset.publicId).toBe(owned.publicId);
      expect(detail?.checks.every((check) => check.state === 'ok')).toBe(true);
      expect(detail?.audit.map((entry) => entry.action)).toContain('claim.start');

      await revokeClaim({ actor, claimId: owned.claimId, reason: 'rights report upheld' });
      const after = await claimDetail(owned.claimId);
      expect(after?.status).toBe('revoked');
      expect(after?.rulingAdminName).toBeTruthy();
      expect(after?.rulingReason).toBe('rights report upheld');
      expect(after?.currentOwner).toBeNull();
      expect(after?.audit[0]?.action).toBe('claim.revoke');
    });

    it('answers null for an unknown or malformed claim id', async () => {
      expect(await claimDetail('junk')).toBeNull();
      expect(await claimDetail(crypto.randomUUID())).toBeNull();
    });
  });

  /* ------------------------------------------------------------- ownership */

  describe('ownership as the dashboard reads it', () => {
    /**
     * The Release control is drawn from `ownershipForAssets` and gated by
     * `isReleasableOwnership`. If the two disagreed with `releaseOwnership`,
     * the screen would either hide a control that works or offer one that
     * strands an asset -- so they are asserted against each other, on the
     * same rows, rather than each on its own.
     */
    it('offers release exactly where releaseOwnership accepts it', async () => {
      const owned = await claimed();
      const created = await asset({ ownerWorkspaceId: owned.workspaceId, sourceType: 'notion' });
      const unclaimed = await asset();

      const views = await ownershipForAssets(owned.workspaceId, [
        owned.assetId,
        created.id,
        unclaimed.id,
      ]);
      expect(views.get(owned.assetId)?.kind).toBe('claimed');
      expect(views.get(created.id)?.kind).toBe('owned');
      expect(views.get(unclaimed.id)?.kind).toBe('unclaimed');

      for (const [assetId, view] of views) {
        const accepted =
          (await refusalOf(
            releaseOwnership({ workspaceId: owned.workspaceId, role: 'owner', assetId }),
          )) === 'accepted';
        expect(accepted).toBe(isReleasableOwnership(view.kind));
      }
    });

    it('shows a pending claim to its claimant and a failed one after the limit', async () => {
      const workspaceId = await workspace();
      const target = await asset();
      const started = await startClaim({
        workspaceId,
        role: 'owner',
        assetPublicId: target.publicId,
        method: 'dns_txt',
      });

      const pending = (await ownershipForAssets(workspaceId, [target.id])).get(target.id);
      expect(pending).toMatchObject({ kind: 'pending', claimId: started.claimId, attempts: 0 });

      outbound.outcome = 'not_found';
      for (let attempt = 0; attempt < CLAIM_ATTEMPT_LIMIT; attempt += 1) {
        await refusalOf(verifyClaim({ claimId: started.claimId, workspaceId, role: 'owner' }));
      }
      const failed = (await ownershipForAssets(workspaceId, [target.id])).get(target.id);
      expect(failed).toMatchObject({ kind: 'failed', claimId: started.claimId });
    });

    it('tells the public page who owns an asset and when the claim went through', async () => {
      const owned = await claimed();
      const created = await asset({ ownerWorkspaceId: await workspace('creator') });
      const unclaimed = await asset();

      const claimedStatus = await publicClaimStatus(owned.publicId);
      expect(claimedStatus.claimed).toBe(true);
      expect(claimedStatus.claimedAt).toBeInstanceOf(Date);

      /* Owned by creation: claimed, but there is no claim to date it from. */
      const createdStatus = await publicClaimStatus(created.publicId);
      expect(createdStatus.claimed).toBe(true);
      expect(createdStatus.claimedAt).toBeNull();

      expect(await publicClaimStatus(unclaimed.publicId)).toMatchObject({
        claimed: false,
        ownerName: null,
        claimedAt: null,
      });
    });

    it('returns a released asset to the pool for the next claimant', async () => {
      const owned = await claimed();
      await releaseOwnership({ workspaceId: owned.workspaceId, role: 'owner', assetId: owned.assetId });

      const next = await workspace('next');
      const started = await startClaim({
        workspaceId: next,
        role: 'owner',
        assetPublicId: owned.publicId,
        method: 'dns_txt',
      });
      expect(started.disputed).toBe(false);

      outbound.outcome = 'matched';
      const verified = await verifyClaim({ claimId: started.claimId, workspaceId: next, role: 'owner' });
      expect(verified.status).toBe('verified');
      expect(await ownerOf(owned.assetId)).toBe(next);
      /* The old owner's claim stays closed; it is history, not a live record. */
      expect((await claimRow(owned.claimId))?.status).toBe('revoked');
    });
  });
});

async function claimsOn(assetId: string) {
  return db()
    .select({ id: schema.assetClaim.id })
    .from(schema.assetClaim)
    .where(eq(schema.assetClaim.assetId, assetId));
}
