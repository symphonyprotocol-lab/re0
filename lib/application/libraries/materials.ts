/**
 * The owner's rights declaration: what a public library carries about where
 * its content came from (required to go public, lib/domain/rights.ts). It
 * does not hold a library back from publishing: public review before
 * publication ended on 2026-10-23. review-visibility-proposal.md 5.1.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { AppError } from '@/contracts/errors';
import { PlatformLibraryRefused } from '@/lib/domain/library';
import {
  parseRightsDeclaration,
  readRightsDeclaration,
  rightsAllowPublic,
  type RightsDeclaration,
} from '@/lib/domain/rights';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { canManageLibraries, type WorkspaceRole } from './delete';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Reader = Pick<ReturnType<typeof db>, 'select'>;

/* --------------------------------------------------------------- readiness */

export interface LibraryMaterials {
  rights: RightsDeclaration | null;
}

/** The declaration, for the owner's panel and the console. */
export async function libraryMaterials(reader: Reader, libraryId: string): Promise<LibraryMaterials> {
  const [row] = await reader
    .select({ rights: schema.library.rightsDeclaration })
    .from(schema.library)
    .where(eq(schema.library.id, libraryId))
    .limit(1);
  return { rights: readRightsDeclaration(row?.rights) };
}

/* ------------------------------------------------------------------ rights */

/** The workspace's own live user library, or `library_not_found`. */
async function ownedLibrary(reader: Reader, workspaceId: string, libraryId: string) {
  if (!UUID.test(libraryId)) throw new AppError('library_not_found', 'no such library');
  const [row] = await reader
    .select({
      id: schema.library.id,
      publicId: schema.library.publicId,
      visibility: schema.library.visibility,
      rights: schema.library.rightsDeclaration,
    })
    .from(schema.library)
    .where(
      and(
        eq(schema.library.id, libraryId),
        eq(schema.library.ownerWorkspaceId, workspaceId),
        eq(schema.library.isPlatformLibrary, false),
        isNull(schema.library.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw new AppError('library_not_found', 'no such library');
  return row;
}

function assertManager(role: WorkspaceRole, verb: string): void {
  if (!canManageLibraries(role)) {
    throw new AppError('access_denied', `only a workspace owner or admin can ${verb}`);
  }
}

export interface DeclareRightsInput {
  workspaceId: string;
  role: WorkspaceRole;
  libraryId: string;
  /** The signed-in user, recorded as who declared. */
  userId: string | null;
  rights: { origin?: unknown; license?: unknown; generation?: unknown; note?: unknown };
}

/**
 * Record or replace the owner's declaration. A declaration that does not
 * permit a public library is still recorded on a private one -- it is the
 * owner's statement about their content -- and refused on a public one,
 * which must not carry a declaration it cannot publish under.
 */
export async function declareLibraryRights(input: DeclareRightsInput): Promise<RightsDeclaration> {
  assertManager(input.role, 'declare rights');
  const database = db();
  const target = await ownedLibrary(database, input.workspaceId, input.libraryId);
  const declaration = parseRightsDeclaration(input.rights, { userId: input.userId, now: new Date() });
  if (!declaration) throw new PlatformLibraryRefused('rights_invalid', 'the declaration is incomplete');
  if (target.visibility === 'public' && !rightsAllowPublic(declaration)) {
    throw new PlatformLibraryRefused('rights_generated', 'model-generated content is not accepted as public');
  }
  await database
    .update(schema.library)
    .set({ rightsDeclaration: declaration })
    .where(eq(schema.library.id, target.id));
  return declaration;
}
