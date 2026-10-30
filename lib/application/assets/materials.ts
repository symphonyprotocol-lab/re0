/**
 * The owner's rights declaration: what a public asset carries about where
 * its content came from (required to go public, lib/domain/rights.ts). It
 * does not hold an asset back from publishing: public review before
 * publication ended on 2026-10-23. review-visibility-proposal.md 5.1.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { AppError } from '@/contracts/errors';
import { PlatformAssetRefused } from '@/lib/domain/asset';
import {
  parseRightsDeclaration,
  readRightsDeclaration,
  rightsAllowPublic,
  type RightsDeclaration,
} from '@/lib/domain/rights';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { canManageAssets, type WorkspaceRole } from './delete';
import { listedInPublicChannel } from '@/lib/application/channels/visibility';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Reader = Pick<ReturnType<typeof db>, 'select'>;

/* --------------------------------------------------------------- readiness */

export interface AssetMaterials {
  rights: RightsDeclaration | null;
}

/** The declaration, for the owner's panel and the console. */
export async function assetMaterials(reader: Reader, assetId: string): Promise<AssetMaterials> {
  const [row] = await reader
    .select({ rights: schema.asset.rightsDeclaration })
    .from(schema.asset)
    .where(eq(schema.asset.id, assetId))
    .limit(1);
  return { rights: readRightsDeclaration(row?.rights) };
}

/* ------------------------------------------------------------------ rights */

/** The workspace's own live user asset, or `library_not_found`. */
async function ownedAsset(reader: Reader, workspaceId: string, assetId: string) {
  if (!UUID.test(assetId)) throw new AppError('library_not_found', 'no such asset');
  const [row] = await reader
    .select({
      id: schema.asset.id,
      publicId: schema.asset.publicId,
      rights: schema.asset.rightsDeclaration,
      listed: listedInPublicChannel(),
    })
    .from(schema.asset)
    .where(
      and(
        eq(schema.asset.id, assetId),
        eq(schema.asset.ownerWorkspaceId, workspaceId),
        eq(schema.asset.isPlatformAsset, false),
        isNull(schema.asset.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw new AppError('library_not_found', 'no such asset');
  return row;
}

function assertManager(role: WorkspaceRole, verb: string): void {
  if (!canManageAssets(role)) {
    throw new AppError('access_denied', `only a workspace owner or admin can ${verb}`);
  }
}

export interface DeclareRightsInput {
  workspaceId: string;
  role: WorkspaceRole;
  assetId: string;
  /** The signed-in user, recorded as who declared. */
  userId: string | null;
  rights: { origin?: unknown; license?: unknown; generation?: unknown; note?: unknown };
}

/**
 * Record or replace the owner's declaration. A declaration that does not
 * permit public distribution is still recorded on an asset that is its
 * owner's alone -- it is the owner's statement about their content -- and
 * refused on one in a public channel, which must not carry a declaration it
 * cannot be shown under (agent-first-proposal.md 6.11).
 */
export async function declareAssetRights(input: DeclareRightsInput): Promise<RightsDeclaration> {
  assertManager(input.role, 'declare rights');
  const database = db();
  const target = await ownedAsset(database, input.workspaceId, input.assetId);
  const declaration = parseRightsDeclaration(input.rights, { userId: input.userId, now: new Date() });
  if (!declaration) throw new PlatformAssetRefused('rights_invalid', 'the declaration is incomplete');
  if (target.listed && !rightsAllowPublic(declaration)) {
    throw new PlatformAssetRefused('rights_generated', 'model-generated content is not accepted as public');
  }
  await database
    .update(schema.asset)
    .set({ rightsDeclaration: declaration })
    .where(eq(schema.asset.id, target.id));
  return declaration;
}
