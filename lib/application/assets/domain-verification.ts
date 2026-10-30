/**
 * Use cases: start a challenge that proves a workspace controls a host, check
 * it, and spend it on an asset. requirement.md 7.3.2, architecture.md 5.4.
 *
 * The wizard cannot create a website asset without a verified challenge
 * for the source's host (lib/domain/domain-verification.ts
 * says which, and why). The shape follows the claim rules that already bind
 * ownership: the token is high entropy and only its hash is stored; the
 * plaintext goes back once, to whoever started the challenge, and must be
 * presented again on every check -- so a check with the wrong token reads
 * like a check against nothing. Failure carries a stable reason and no DNS
 * payload or fetched body (requirement.md 7.3.7).
 */
import { and, eq, gt, sql } from 'drizzle-orm';
import { AppError } from '@/contracts/errors';
import {
  CHALLENGE_TTL_MS,
  dnsChallengeName,
  dnsChallengeValue,
  isDomainVerificationMethod,
  matchesDnsChallenge,
  matchesWellKnownBody,
  MAX_CHECK_ATTEMPTS,
  MAX_STARTS_PER_HOUR,
  requiresDomainVerification,
  verificationHost,
  verificationSpendable,
  wellKnownUrl,
  type DomainVerificationFailure,
  type DomainVerificationMethod,
} from '@/lib/domain/domain-verification';
import { uuidv7 } from '@/lib/domain/id';
import { normalizeLocation, type ConnectedSourceType } from '@/lib/domain/asset';
import {
  domainChallengeReader,
  type DomainChallengeReader,
} from '@/lib/infrastructure/connectors/verification';
import { randomToken, sha256, timingSafeEqual } from '@/lib/infrastructure/crypto/tokens';
import { db, schema, type Database } from '@/lib/infrastructure/postgres/client';

/** What `db().transaction` hands its callback. */
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
import { canManageAssets, type WorkspaceRole } from './delete';

export interface StartDomainVerificationInput {
  workspaceId: string;
  role: WorkspaceRole;
  sourceType: ConnectedSourceType;
  location: string;
  method: unknown;
  now?: Date;
}

/** Everything the wizard shows, and the one copy of the token that exists. */
export interface DomainChallenge {
  verificationId: string;
  host: string;
  method: DomainVerificationMethod;
  token: string;
  /** For dns_txt: the record name and the value to put in it. */
  dnsName: string;
  dnsValue: string;
  /** For well_known: the URL to serve, and the body to serve at it. */
  wellKnownUrl: string;
  expiresAt: Date;
}

export async function startDomainVerification(
  input: StartDomainVerificationInput,
): Promise<DomainChallenge> {
  if (!canManageAssets(input.role)) {
    throw new AppError('access_denied', 'only a workspace owner or admin can create an asset');
  }
  if (!requiresDomainVerification(input.sourceType)) {
    throw new AppError('invalid_request', 'this source type does not verify a domain');
  }
  const method = input.method;
  if (!isDomainVerificationMethod(method)) {
    throw new AppError('invalid_request', 'unsupported verification method');
  }
  const location = normalizeLocation(input.sourceType, input.location);
  const host = location ? verificationHost(location) : null;
  if (!host) {
    throw new AppError('invalid_request', 'the source location is not valid for this source type');
  }

  const now = input.now ?? new Date();
  const database = db();

  /* requirement.md 7.3.7: starts are limited per workspace. A challenge
     costs nothing to answer wrongly, so what this bounds is the number of
     hosts one workspace can point lookups at. */
  const [recent] = await database
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.domainVerification)
    .where(
      and(
        eq(schema.domainVerification.workspaceId, input.workspaceId),
        gt(schema.domainVerification.createdAt, new Date(now.getTime() - 60 * 60 * 1000)),
      ),
    );
  if ((recent?.n ?? 0) >= MAX_STARTS_PER_HOUR) {
    throw new AppError('claim_verification_failed', 'too many challenges started', 'retry_limit_exceeded');
  }

  const token = randomToken(32);
  const verificationId = uuidv7(now.getTime());
  const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_MS);

  await database.transaction(async (tx) => {
    /* One live challenge per host per workspace: starting again replaces
       the earlier one, so a record someone placed for the old token stops
       verifying once they asked for a new one. */
    await tx
      .update(schema.domainVerification)
      .set({ status: 'expired', failureReason: 'challenge_expired' })
      .where(
        and(
          eq(schema.domainVerification.workspaceId, input.workspaceId),
          eq(schema.domainVerification.host, host),
          eq(schema.domainVerification.status, 'pending'),
        ),
      );
    await tx.insert(schema.domainVerification).values({
      id: verificationId,
      workspaceId: input.workspaceId,
      host,
      method,
      challengeTokenHash: await sha256(token),
      status: 'pending',
      expiresAt,
      createdAt: now,
    });
  });

  return {
    verificationId,
    host,
    method,
    token,
    dnsName: dnsChallengeName(host),
    dnsValue: dnsChallengeValue(token),
    wellKnownUrl: wellKnownUrl(host, token),
    expiresAt,
  };
}

export interface CheckDomainVerificationInput {
  workspaceId: string;
  role: WorkspaceRole;
  verificationId: string;
  /** The plaintext the start call returned; never stored, so it must come back. */
  token: string;
  now?: Date;
  /** Seam for tests; production asks DNS and the host. */
  reader?: DomainChallengeReader;
}

export type CheckDomainVerificationResult =
  | { ok: true; host: string; verifiedAt: Date }
  | { ok: false; reason: DomainVerificationFailure };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function checkDomainVerification(
  input: CheckDomainVerificationInput,
): Promise<CheckDomainVerificationResult> {
  if (!canManageAssets(input.role)) {
    throw new AppError('access_denied', 'only a workspace owner or admin can create an asset');
  }
  const now = input.now ?? new Date();
  const database = db();
  const notFound = { ok: false, reason: 'challenge_not_found' } as const;

  if (!UUID.test(input.verificationId) || typeof input.token !== 'string') return notFound;

  const [row] = await database
    .select()
    .from(schema.domainVerification)
    .where(
      and(
        eq(schema.domainVerification.id, input.verificationId),
        eq(schema.domainVerification.workspaceId, input.workspaceId),
      ),
    );
  /* Another workspace's challenge, a made-up id and a wrong token all get
     the same answer: nothing about a challenge is learnable by probing. */
  if (!row) return notFound;
  if (!timingSafeEqual(row.challengeTokenHash, await sha256(input.token))) return notFound;

  if (row.status === 'verified' && row.verifiedAt && !row.consumedAssetId) {
    return { ok: true, host: row.host, verifiedAt: row.verifiedAt };
  }
  if (row.status !== 'pending') {
    return { ok: false, reason: row.failureReason === 'retry_limit_exceeded' ? 'retry_limit_exceeded' : 'challenge_expired' };
  }
  if (row.expiresAt.getTime() <= now.getTime()) {
    await database
      .update(schema.domainVerification)
      .set({ status: 'expired', failureReason: 'challenge_expired' })
      .where(eq(schema.domainVerification.id, row.id));
    return { ok: false, reason: 'challenge_expired' };
  }
  if (row.attempts >= MAX_CHECK_ATTEMPTS) {
    await database
      .update(schema.domainVerification)
      .set({ status: 'failed', failureReason: 'retry_limit_exceeded' })
      .where(eq(schema.domainVerification.id, row.id));
    return { ok: false, reason: 'retry_limit_exceeded' };
  }

  const reader = input.reader ?? domainChallengeReader;
  let found = false;
  if (row.method === 'dns_txt') {
    found = matchesDnsChallenge(await reader.txtRecords(dnsChallengeName(row.host)), input.token);
  } else if (row.method === 'well_known') {
    const body = await reader.wellKnownBody(wellKnownUrl(row.host, input.token));
    found = body !== null && matchesWellKnownBody(body, input.token);
  }

  if (found) {
    await database
      .update(schema.domainVerification)
      .set({ status: 'verified', verifiedAt: now, failureReason: null, attempts: row.attempts + 1 })
      .where(eq(schema.domainVerification.id, row.id));
    return { ok: true, host: row.host, verifiedAt: now };
  }
  await database
    .update(schema.domainVerification)
    .set({ failureReason: 'challenge_not_found', attempts: row.attempts + 1 })
    .where(eq(schema.domainVerification.id, row.id));
  return notFound;
}

/**
 * Spends a verified challenge on the asset being created, inside the
 * creation transaction: the row is locked, checked against the source's
 * host and the freshness window, marked consumed, and copied onto
 * `asset_claim` as a verified claim so the asset counts as claimed
 * (requirement.md 7.3.4) from the moment it exists. Fails the transaction,
 * and so the creation, if the challenge cannot be spent.
 */
export async function consumeDomainVerification(
  tx: Transaction,
  input: {
    workspaceId: string;
    verificationId: unknown;
    location: string;
    assetId: string;
    now: Date;
  },
): Promise<void> {
  const refuse = (reason: DomainVerificationFailure): never => {
    throw new AppError('claim_verification_failed', 'the source domain is not verified', reason);
  };
  if (typeof input.verificationId !== 'string' || !UUID.test(input.verificationId)) {
    refuse('challenge_not_found');
  }
  const [row] = await tx
    .select()
    .from(schema.domainVerification)
    .where(
      and(
        eq(schema.domainVerification.id, input.verificationId as string),
        eq(schema.domainVerification.workspaceId, input.workspaceId),
      ),
    )
    .for('update');
  if (!row) refuse('challenge_not_found');
  const why = verificationSpendable(row!, input.location, input.now);
  if (why) refuse(why);

  await tx
    .update(schema.domainVerification)
    .set({ consumedAssetId: input.assetId })
    .where(eq(schema.domainVerification.id, row!.id));
  await tx.insert(schema.assetClaim).values({
    id: uuidv7(input.now.getTime()),
    assetId: input.assetId,
    claimantWorkspaceId: input.workspaceId,
    method: row!.method,
    challengeTokenHash: row!.challengeTokenHash,
    status: 'verified',
    attempts: row!.attempts,
    expiresAt: row!.expiresAt,
    verifiedAt: input.now,
    createdAt: input.now,
  });
}
