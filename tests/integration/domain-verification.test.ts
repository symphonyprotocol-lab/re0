/**
 * Proving control of a host before a website asset is created
 * (requirement.md 7.3.2, architecture.md 5.4): a challenge is
 * started, checked against DNS or the well-known file through a fake reader,
 * spent on exactly one asset, and refused for anything else.
 *
 * Runs only when TEST_DATABASE_URL points at a disposable database.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

process.env.DATABASE_URL = TEST_DATABASE_URL ?? 'postgres://unused';
process.env.SESSION_SIGNING_SECRET ??= 'test-secret-that-is-long-enough-000000';

const { AppError } = await import('@/contracts/errors');
const { checkDomainVerification, createWorkspaceAsset, startDomainVerification } = await import(
  '@/lib/application/assets'
);
const { dnsChallengeValue, MAX_CHECK_ATTEMPTS, VERIFIED_VALID_MS } = await import(
  '@/lib/domain/domain-verification'
);
const { db, schema } = await import('@/lib/infrastructure/postgres/client');

const workspaces: string[] = [];
const assets: string[] = [];

/** A DNS and a web that serve what the test put there, and nothing else. */
function fakeReader() {
  const txt = new Map<string, string[][]>();
  const files = new Map<string, string>();
  return {
    txt,
    files,
    txtRecords: async (name: string) => txt.get(name) ?? [],
    wellKnownBody: async (url: string) => files.get(url) ?? null,
  };
}

async function workspace(): Promise<string> {
  const id = crypto.randomUUID();
  workspaces.push(id);
  await db().insert(schema.workspace).values({ id, name: 'domain-verification-test' });
  return id;
}

describeWithDb('domain verification', () => {
  afterAll(async () => {
    const database = db();
    if (assets.length > 0) {
      await database
        .delete(schema.workflowOperation)
        .where(inArray(schema.workflowOperation.assetId, assets));
      await database
        .delete(schema.assetClaim)
        .where(inArray(schema.assetClaim.assetId, assets));
      await database.delete(schema.source).where(inArray(schema.source.assetId, assets));
    }
    if (workspaces.length > 0) {
      await database
        .delete(schema.domainVerification)
        .where(inArray(schema.domainVerification.workspaceId, workspaces));
    }
    if (assets.length > 0) {
      await database.delete(schema.asset).where(inArray(schema.asset.id, assets));
    }
    if (workspaces.length > 0) {
      await database.delete(schema.workspace).where(inArray(schema.workspace.id, workspaces));
    }
  });

  it('refuses to create a website asset without a verified challenge', async () => {
    const workspaceId = await workspace();
    await expect(
      createWorkspaceAsset({
        workspaceId,
        role: 'owner',
        title: 'Unverified',
        sourceType: 'website',
        location: 'https://docs.example.test/',
        slug: `unverified-${Date.now()}`,
      }),
    ).rejects.toMatchObject({ code: 'claim_verification_failed', reason: 'challenge_not_found' });
  });

  it('verifies by DNS TXT, spends the challenge on one asset, and records the claim', async () => {
    const workspaceId = await workspace();
    const reader = fakeReader();

    const challenge = await startDomainVerification({
      workspaceId,
      role: 'owner',
      sourceType: 'website',
      location: 'https://Docs.Example.test/guide',
      method: 'dns_txt',
    });
    expect(challenge.host).toBe('docs.example.test');
    expect(challenge.dnsName).toBe('_re0-challenge.docs.example.test');
    expect(challenge.dnsValue).toBe(dnsChallengeValue(challenge.token));

    /* Only the hash is on the row. */
    const [row] = await db()
      .select()
      .from(schema.domainVerification)
      .where(eq(schema.domainVerification.id, challenge.verificationId));
    expect(row?.status).toBe('pending');
    expect(row?.challengeTokenHash).not.toContain(challenge.token);

    /* Not there yet. */
    const check = { workspaceId, role: 'owner' as const, verificationId: challenge.verificationId, token: challenge.token, reader };
    expect(await checkDomainVerification(check)).toEqual({ ok: false, reason: 'challenge_not_found' });

    /* A wrong token reads the same as no challenge at all. */
    expect(await checkDomainVerification({ ...check, token: 'wrong' })).toEqual({
      ok: false,
      reason: 'challenge_not_found',
    });

    reader.txt.set(challenge.dnsName, [['v=spf1 -all'], [challenge.dnsValue]]);
    const verified = await checkDomainVerification(check);
    expect(verified.ok).toBe(true);

    /* Creation refuses an asset on a host the challenge did not name... */
    await expect(
      createWorkspaceAsset({
        workspaceId,
        role: 'owner',
        title: 'Other host',
        sourceType: 'website',
        location: 'https://example.test/',
        slug: `other-${Date.now()}`,
        domainVerificationId: challenge.verificationId,
      }),
    ).rejects.toMatchObject({ code: 'claim_verification_failed', reason: 'source_mismatch' });

    /* ...and takes the one it did, at another path even: the host is what was proven. */
    const created = await createWorkspaceAsset({
      workspaceId,
      role: 'owner',
      title: 'Guide',
      sourceType: 'website',
      location: 'https://docs.example.test/guide/',
      slug: `guide-${Date.now()}`,
      domainVerificationId: challenge.verificationId,
    });
    assets.push(created.assetId);

    const [spent] = await db()
      .select()
      .from(schema.domainVerification)
      .where(eq(schema.domainVerification.id, challenge.verificationId));
    expect(spent?.consumedAssetId).toBe(created.assetId);

    const claims = await db()
      .select()
      .from(schema.assetClaim)
      .where(eq(schema.assetClaim.assetId, created.assetId));
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      claimantWorkspaceId: workspaceId,
      method: 'dns_txt',
      status: 'verified',
      challengeTokenHash: row?.challengeTokenHash,
    });

    /* Spent means spent. */
    await expect(
      createWorkspaceAsset({
        workspaceId,
        role: 'owner',
        title: 'Again',
        sourceType: 'website',
        location: 'https://docs.example.test/',
        slug: `again-${Date.now()}`,
        domainVerificationId: challenge.verificationId,
      }),
    ).rejects.toMatchObject({ code: 'claim_verification_failed', reason: 'challenge_not_found' });
  });

  it('verifies by well-known file', async () => {
    const workspaceId = await workspace();
    const reader = fakeReader();

    const challenge = await startDomainVerification({
      workspaceId,
      role: 'admin',
      sourceType: 'website',
      location: 'https://api.example.test/reference/',
      method: 'well_known',
    });
    expect(challenge.wellKnownUrl).toBe(
      `https://api.example.test/.well-known/re0-challenge/${challenge.token}`,
    );
    const check = { workspaceId, role: 'admin' as const, verificationId: challenge.verificationId, token: challenge.token, reader };

    reader.files.set(challenge.wellKnownUrl, `<html>${challenge.token}</html>`);
    expect(await checkDomainVerification(check)).toEqual({ ok: false, reason: 'challenge_not_found' });

    reader.files.set(challenge.wellKnownUrl, `${challenge.token}\n`);
    expect((await checkDomainVerification(check)).ok).toBe(true);

    const created = await createWorkspaceAsset({
      workspaceId,
      role: 'admin',
      title: 'API',
      rights: { origin: 'own', license: 'open_source', generation: 'human' },
      sourceType: 'website',
      location: 'https://api.example.test/reference/',
      slug: `api-${Date.now()}`,
      domainVerificationId: challenge.verificationId,
    });
    assets.push(created.assetId);
  });

  it('is not another workspace’s to check or spend', async () => {
    const owner = await workspace();
    const stranger = await workspace();
    const reader = fakeReader();
    const challenge = await startDomainVerification({
      workspaceId: owner,
      role: 'owner',
      sourceType: 'website',
      location: 'https://docs.example.test/',
      method: 'dns_txt',
    });
    reader.txt.set(challenge.dnsName, [[challenge.dnsValue]]);

    expect(
      await checkDomainVerification({
        workspaceId: stranger,
        role: 'owner',
        verificationId: challenge.verificationId,
        token: challenge.token,
        reader,
      }),
    ).toEqual({ ok: false, reason: 'challenge_not_found' });

    expect(
      (
        await checkDomainVerification({
          workspaceId: owner,
          role: 'owner',
          verificationId: challenge.verificationId,
          token: challenge.token,
          reader,
        })
      ).ok,
    ).toBe(true);

    await expect(
      createWorkspaceAsset({
        workspaceId: stranger,
        role: 'owner',
        title: 'Stolen',
        sourceType: 'website',
        location: 'https://docs.example.test/',
        slug: `stolen-${Date.now()}`,
        domainVerificationId: challenge.verificationId,
      }),
    ).rejects.toMatchObject({ code: 'claim_verification_failed', reason: 'challenge_not_found' });
  });

  it('expires, locks after too many checks, and goes stale once verified too long ago', async () => {
    const workspaceId = await workspace();
    const reader = fakeReader();
    const start = () =>
      startDomainVerification({
        workspaceId,
        role: 'owner',
        sourceType: 'website',
        location: 'https://docs.example.test/',
        method: 'dns_txt',
      });

    const expired = await start();
    expect(
      await checkDomainVerification({
        workspaceId,
        role: 'owner',
        verificationId: expired.verificationId,
        token: expired.token,
        reader,
        now: new Date(expired.expiresAt.getTime() + 1),
      }),
    ).toEqual({ ok: false, reason: 'challenge_expired' });

    const locked = await start();
    for (let i = 0; i < MAX_CHECK_ATTEMPTS; i += 1) {
      await checkDomainVerification({ workspaceId, role: 'owner', verificationId: locked.verificationId, token: locked.token, reader });
    }
    reader.txt.set(locked.dnsName, [[locked.dnsValue]]);
    expect(
      await checkDomainVerification({ workspaceId, role: 'owner', verificationId: locked.verificationId, token: locked.token, reader }),
    ).toEqual({ ok: false, reason: 'retry_limit_exceeded' });

    const stale = await start();
    reader.txt.set(stale.dnsName, [[stale.dnsValue]]);
    const verifiedAt = new Date(Date.now() - VERIFIED_VALID_MS - 60_000);
    expect(
      (
        await checkDomainVerification({ workspaceId, role: 'owner', verificationId: stale.verificationId, token: stale.token, reader, now: verifiedAt })
      ).ok,
    ).toBe(true);
    await expect(
      createWorkspaceAsset({
        workspaceId,
        role: 'owner',
        title: 'Stale',
        sourceType: 'website',
        location: 'https://docs.example.test/',
        slug: `stale-${Date.now()}`,
        domainVerificationId: stale.verificationId,
      }),
    ).rejects.toMatchObject({ code: 'claim_verification_failed', reason: 'challenge_expired' });

    /* A member may not start one at all. */
    await expect(
      startDomainVerification({ workspaceId, role: 'viewer', sourceType: 'website', location: 'https://docs.example.test/', method: 'dns_txt' }),
    ).rejects.toBeInstanceOf(AppError);
  });
});
