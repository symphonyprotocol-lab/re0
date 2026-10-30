/**
 * Read models for the claim screens. requirement.md 5.1, 5.2.
 *
 * Nothing here decides anything; the dashboard, the public detail page and
 * the claim page read what the write paths left behind.
 */
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { ClaimFailureReason } from '@/contracts/errors';
import type { ClaimMethod, ClaimStatus, SourceType } from '@/lib/domain';
import { claimMethodsFor } from '@/lib/domain';
import {
  checkStates,
  dnsRecordName,
  isDisputedClaim,
  ownershipView,
  verificationDomain,
  wellKnownUrl,
  type ClaimCheckView,
  type OwnershipView,
} from '@/lib/domain/claim';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { ref } from '@/lib/application/administration/column-ref';
import { isUuid, loadClaim, notFound, visibleAsset } from './shared';

export interface WorkspaceClaimRow {
  id: string;
  assetId: string;
  assetPublicId: string;
  assetTitle: string;
  method: ClaimMethod;
  status: ClaimStatus;
  failureReason: ClaimFailureReason | null;
  attempts: number;
  expiresAt: Date;
  verifiedAt: Date | null;
  createdAt: Date;
  /** The asset has another owner, so this claim waits on an administrator. */
  disputed: boolean;
  ownerName: string | null;
}

const ownerName = sql<string | null>`(
  select ${ref(schema.workspace.name)} from ${schema.workspace}
  where ${ref(schema.workspace.id)} = ${ref(schema.asset.ownerWorkspaceId)}
)`;

/** Every claim this workspace has opened, newest first. */
export async function listWorkspaceClaims(workspaceId: string): Promise<WorkspaceClaimRow[]> {
  const rows = await db()
    .select({
      id: schema.assetClaim.id,
      assetId: schema.assetClaim.assetId,
      assetPublicId: schema.asset.publicId,
      assetTitle: schema.asset.title,
      method: schema.assetClaim.method,
      status: schema.assetClaim.status,
      failureReason: schema.assetClaim.failureReason,
      attempts: schema.assetClaim.attempts,
      expiresAt: schema.assetClaim.expiresAt,
      verifiedAt: schema.assetClaim.verifiedAt,
      createdAt: schema.assetClaim.createdAt,
      ownerWorkspaceId: schema.asset.ownerWorkspaceId,
      ownerName,
    })
    .from(schema.assetClaim)
    .innerJoin(schema.asset, eq(schema.asset.id, schema.assetClaim.assetId))
    .where(
      and(eq(schema.assetClaim.claimantWorkspaceId, workspaceId), isNull(schema.asset.deletedAt)),
    )
    .orderBy(desc(schema.assetClaim.createdAt));

  return rows.map((row) => ({
    id: row.id,
    assetId: row.assetId,
    assetPublicId: row.assetPublicId,
    assetTitle: row.assetTitle,
    method: row.method,
    status: row.status,
    failureReason: row.failureReason as ClaimFailureReason | null,
    attempts: row.attempts,
    expiresAt: row.expiresAt,
    verifiedAt: row.verifiedAt,
    createdAt: row.createdAt,
    disputed: isDisputedClaim({
      status: row.status,
      ownerWorkspaceId: row.ownerWorkspaceId,
      claimantWorkspaceId: workspaceId,
    }),
    ownerName: row.ownerName,
  }));
}

/**
 * How each of the given assets stands with this workspace: claimed, owned
 * by creation, pending, failed or unclaimed. One query for the whole list.
 */
export async function ownershipForAssets(
  workspaceId: string,
  assetIds: string[],
): Promise<Map<string, OwnershipView>> {
  const result = new Map<string, OwnershipView>();
  if (assetIds.length === 0) return result;

  const database = db();
  const [assets, claims] = await Promise.all([
    database
      .select({
        id: schema.asset.id,
        ownerWorkspaceId: schema.asset.ownerWorkspaceId,
        ownerName,
      })
      .from(schema.asset)
      .where(inArray(schema.asset.id, assetIds)),
    database
      .select({
        id: schema.assetClaim.id,
        assetId: schema.assetClaim.assetId,
        status: schema.assetClaim.status,
        failureReason: schema.assetClaim.failureReason,
        attempts: schema.assetClaim.attempts,
        expiresAt: schema.assetClaim.expiresAt,
        verifiedAt: schema.assetClaim.verifiedAt,
      })
      .from(schema.assetClaim)
      .where(
        and(
          eq(schema.assetClaim.claimantWorkspaceId, workspaceId),
          inArray(schema.assetClaim.assetId, assetIds),
        ),
      )
      .orderBy(desc(schema.assetClaim.createdAt)),
  ]);

  const newest = new Map<string, (typeof claims)[number]>();
  for (const claim of claims) {
    if (!newest.has(claim.assetId)) newest.set(claim.assetId, claim);
  }

  for (const asset of assets) {
    const claim = newest.get(asset.id);
    result.set(
      asset.id,
      ownershipView(
        {
          ownerWorkspaceId: asset.ownerWorkspaceId,
          ownerName: asset.ownerName,
          claim: claim
            ? {
                id: claim.id,
                status: claim.status,
                failureReason: claim.failureReason as ClaimFailureReason | null,
                attempts: claim.attempts,
                expiresAt: claim.expiresAt,
                verifiedAt: claim.verifiedAt,
              }
            : null,
        },
        workspaceId,
      ),
    );
  }
  return result;
}

export interface PublicClaimStatus {
  claimed: boolean;
  ownerName: string | null;
  /** When the owner's verified claim went through; null for an owner by creation. */
  claimedAt: Date | null;
}

/** What the public detail page says about ownership. requirement.md 5.1, 7.3.4. */
export async function publicClaimStatus(assetPublicId: string): Promise<PublicClaimStatus> {
  const [row] = await db()
    .select({
      id: schema.asset.id,
      ownerWorkspaceId: schema.asset.ownerWorkspaceId,
      ownerName,
    })
    .from(schema.asset)
    .where(and(eq(schema.asset.publicId, assetPublicId), isNull(schema.asset.deletedAt)))
    .limit(1);
  if (!row || !row.ownerWorkspaceId) return { claimed: false, ownerName: null, claimedAt: null };

  const [claim] = await db()
    .select({ verifiedAt: schema.assetClaim.verifiedAt })
    .from(schema.assetClaim)
    .where(
      and(
        eq(schema.assetClaim.assetId, row.id),
        eq(schema.assetClaim.claimantWorkspaceId, row.ownerWorkspaceId),
        eq(schema.assetClaim.status, 'verified'),
      ),
    )
    .orderBy(desc(schema.assetClaim.verifiedAt))
    .limit(1);

  return { claimed: true, ownerName: row.ownerName, claimedAt: claim?.verifiedAt ?? null };
}

/** What the claim page needs about the asset before a claim exists. */
export interface ClaimTarget {
  publicId: string;
  title: string;
  sourceType: SourceType;
  location: string;
  methods: readonly ClaimMethod[];
  /** Owned by another workspace, so a new claim would be a dispute. */
  ownedByOther: boolean;
  ownedBySelf: boolean;
  ownerName: string | null;
}

export async function claimTarget(
  workspaceId: string,
  assetPublicId: string,
): Promise<ClaimTarget> {
  const asset = await visibleAsset(assetPublicId);
  let owner: string | null = null;
  if (asset.ownerWorkspaceId) {
    const [row] = await db()
      .select({ name: schema.workspace.name })
      .from(schema.workspace)
      .where(eq(schema.workspace.id, asset.ownerWorkspaceId));
    owner = row?.name ?? null;
  }
  return {
    publicId: asset.publicId,
    title: asset.title,
    sourceType: asset.sourceType,
    location: asset.location,
    methods: claimMethodsFor(asset.sourceType),
    ownedByOther:
      asset.ownerWorkspaceId !== null && asset.ownerWorkspaceId !== workspaceId,
    ownedBySelf: asset.ownerWorkspaceId === workspaceId,
    ownerName: owner,
  };
}

/** One claim as its claimant sees it, with the instructions to complete it. */
export interface ClaimantClaimView extends WorkspaceClaimRow {
  checks: ClaimCheckView[];
  /** The source address the instructions name, e.g. `owner/repository`. */
  location: string;
  /** Where the TXT record goes; null for the GitHub method or an unresolvable domain. */
  dnsRecordName: string | null;
  wellKnownUrl: string | null;
}

export async function claimForClaimant(
  workspaceId: string,
  claimId: string,
): Promise<ClaimantClaimView> {
  if (!isUuid(claimId)) throw notFound();
  const claim = await loadClaim(claimId);
  if (!claim || claim.claimantWorkspaceId !== workspaceId) throw notFound();

  const [asset] = await db()
    .select({
      publicId: schema.asset.publicId,
      title: schema.asset.title,
      ownerWorkspaceId: schema.asset.ownerWorkspaceId,
      ownerName,
      deletedAt: schema.asset.deletedAt,
      sourceType: schema.source.type,
      location: schema.source.location,
    })
    .from(schema.asset)
    .innerJoin(schema.source, eq(schema.source.assetId, schema.asset.id))
    .where(eq(schema.asset.id, claim.assetId))
    .orderBy(schema.source.id)
    .limit(1);
  if (!asset || asset.deletedAt) throw notFound();

  /*
   * A GitHub source's home domain is not stored, and the page is not the
   * place to ask GitHub for it; the instructions name the domain when it is
   * knowable from the source alone and otherwise describe where to look.
   */
  const domain =
    claim.method === 'github_permission'
      ? null
      : verificationDomain({ sourceType: asset.sourceType, location: asset.location });

  return {
    id: claim.id,
    assetId: claim.assetId,
    assetPublicId: asset.publicId,
    assetTitle: asset.title,
    method: claim.method,
    status: claim.status,
    failureReason: claim.failureReason,
    attempts: claim.attempts,
    expiresAt: claim.expiresAt,
    verifiedAt: claim.verifiedAt,
    createdAt: claim.createdAt,
    disputed: isDisputedClaim({
      status: claim.status,
      ownerWorkspaceId: asset.ownerWorkspaceId,
      claimantWorkspaceId: claim.claimantWorkspaceId,
    }),
    ownerName: asset.ownerName,
    location: asset.location,
    checks: checkStates({
      method: claim.method,
      status: claim.status,
      failureReason: claim.failureReason,
      attempted: claim.attempts > 0,
    }),
    dnsRecordName: claim.method === 'dns_txt' && domain ? dnsRecordName(domain) : null,
    wellKnownUrl: claim.method === 'well_known' && domain ? wellKnownUrl(domain, claim.id) : null,
  };
}
