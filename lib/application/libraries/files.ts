/**
 * The files of a PDF library, after it exists.
 *
 * The wizard can create a PDF library with its files, or without them; either
 * way the library's files page is where they are managed from then on. An
 * edit here is the second half of the same contract `createWorkspaceLibrary`
 * enforces: every added file is a manifest entry under this workspace's own
 * prefix, confirmed present in the store at its declared size, and every
 * removed one is a file the source actually lists.
 *
 * Saving with at least one file queues a rebuild through the same workflow
 * queue refreshes use (architecture.md 8.4), and the request returns without
 * waiting for it. The previous version keeps serving until the new one
 * publishes; a failed build leaves it in place (requirement.md 8.2). Objects
 * of removed files are not deleted here: the published version's citations
 * still point at them until the rebuild lands, and the upload sweep collects
 * anything no source lists once it is a day old.
 */
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { AppError } from '@/contracts/errors';
import { uuidv7 } from '@/lib/domain/id';
import {
  isUploadSourceType,
  mergeUploadedFiles,
  parseUploadManifest,
  UPLOAD_SOURCE_TYPES,
  uploadedFilesOf,
  type UploadedFile,
  type UploadSourceType,
} from '@/lib/domain/library';
import type { IndexStatus, LifecycleStatus } from '@/lib/domain';
import type { ObjectStore } from '@/lib/infrastructure/objects/store';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { assertBuildAffordable } from '@/lib/application/plans/build-quota';
import { confirmUploads } from './create';
import { canManageLibraries, type WorkspaceRole } from './delete';
import { openBuild, queueBuildUnlessPending } from './queue-build';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;


export interface LibraryFilesView {
  library: {
    id: string;
    publicId: string;
    title: string;
    lifecycleStatus: LifecycleStatus;
    indexStatus: IndexStatus;
  };
  /** Which kind of file the library holds: PDFs, or Markdown/MDX. */
  kind: UploadSourceType;
  files: UploadedFile[];
  /** True while a build is pending or running, so the page can say so. */
  building: boolean;
}

/**
 * What the files page shows. Null for a library this workspace does not own,
 * one that is deleted, or one that is not a PDF library -- all answered the
 * same way, so nothing about someone else's library is confirmed.
 */
export async function libraryFiles(input: {
  workspaceId: string;
  libraryId: string;
}): Promise<LibraryFilesView | null> {
  if (!UUID.test(input.libraryId)) return null;
  const database = db();
  const [row] = await database
    .select({
      id: schema.library.id,
      publicId: schema.library.publicId,
      title: schema.library.title,
      lifecycleStatus: schema.library.lifecycleStatus,
      indexStatus: schema.library.indexStatus,
      type: schema.source.type,
      config: schema.source.config,
    })
    .from(schema.library)
    .innerJoin(schema.source, eq(schema.source.libraryId, schema.library.id))
    .where(
      and(
        ownedPdfLibrary(input.workspaceId, input.libraryId),
        inArray(schema.source.type, [...UPLOAD_SOURCE_TYPES]),
      ),
    )
    .limit(1);
  if (!row || !isUploadSourceType(row.type)) return null;

  const open = await openBuild(database, row.id);
  return {
    library: {
      id: row.id,
      publicId: row.publicId,
      title: row.title,
      lifecycleStatus: row.lifecycleStatus,
      indexStatus: row.indexStatus,
    },
    kind: row.type,
    files: uploadedFilesOf(row.config),
    building: open !== null,
  };
}

export interface UpdateLibraryFilesInput {
  workspaceId: string;
  role: WorkspaceRole;
  libraryId: string;
  /** A manifest of freshly uploaded files, as parsed JSON; absent adds none. */
  add?: unknown;
  /** Ids of listed files to drop. */
  remove?: readonly string[];
  store?: Pick<ObjectStore, 'head'>;
}

export interface UpdateLibraryFilesResult {
  files: UploadedFile[];
  /** The build this edit queued, or found already waiting. Null when there is nothing to build. */
  operationId: string | null;
}

export async function updateLibraryFiles(
  input: UpdateLibraryFilesInput,
): Promise<UpdateLibraryFilesResult> {
  if (!canManageLibraries(input.role)) {
    throw new AppError('access_denied', 'only a workspace owner or admin can change a library');
  }
  if (!UUID.test(input.libraryId)) throw new AppError('library_not_found', 'no such library');

  const remove = input.remove ?? [];
  if (remove.some((id) => typeof id !== 'string' || !UUID.test(id))) {
    throw new AppError('invalid_request', 'a file id to remove is not valid');
  }

  /* The manifest is read against the source's own kind: a `.md` manifest
     posted to a PDF library is refused, not stored. */
  const database = db();
  const [kind] = await database
    .select({ type: schema.source.type })
    .from(schema.library)
    .innerJoin(schema.source, eq(schema.source.libraryId, schema.library.id))
    .where(
      and(
        ownedPdfLibrary(input.workspaceId, input.libraryId),
        inArray(schema.source.type, [...UPLOAD_SOURCE_TYPES]),
      ),
    )
    .limit(1);
  if (!kind || !isUploadSourceType(kind.type)) throw new AppError('library_not_found', 'no such library');
  const manifest =
    input.add === undefined || input.add === null
      ? { files: [] as UploadedFile[] }
      : parseUploadManifest(input.add, input.workspaceId, kind.type);
  if (!manifest) throw new AppError('invalid_request', 'the upload manifest is not valid');
  if (manifest.files.length === 0 && remove.length === 0) {
    throw new AppError('invalid_request', 'nothing to change');
  }

  /* Confirmed before the transaction: a store round-trip per file is not
     something to hold a row lock across. */
  await confirmUploads(manifest.files, input.store);
  /* library-build-billing.md 4.1: a file change that will queue a build is
     refused up front when the balance cannot cover the base fee, as the
     wizard and the rebuild button refuse. Uploads fetch no pages. */
  if (manifest.files.length > 0 || remove.length > 0) {
    await assertBuildAffordable({ workspaceId: input.workspaceId, fetchesPages: false });
  }

  return database.transaction(async (tx) => {
    const [locked] = await tx
      .select({ id: schema.library.id })
      .from(schema.library)
      .where(ownedPdfLibrary(input.workspaceId, input.libraryId))
      .for('update');
    if (!locked) throw new AppError('library_not_found', 'no such library');

    const [source] = await tx
      .select({ id: schema.source.id, config: schema.source.config })
      .from(schema.source)
      .where(
        and(
          eq(schema.source.libraryId, locked.id),
          inArray(schema.source.type, [...UPLOAD_SOURCE_TYPES]),
        ),
      )
      .limit(1);
    if (!source) throw new AppError('library_not_found', 'no such library');

    const files = mergeUploadedFiles(uploadedFilesOf(source.config), manifest.files, remove);
    if (!files) throw new AppError('invalid_request', 'the file list is not valid');

    await tx
      .update(schema.source)
      .set({ config: { ...source.config, files } })
      .where(eq(schema.source.id, source.id));

    if (files.length === 0) return { files, operationId: null };

    return { files, operationId: await queueBuildUnlessPending(tx, locked.id) };
  });
}

function ownedPdfLibrary(workspaceId: string, libraryId: string) {
  return and(
    eq(schema.library.id, libraryId),
    eq(schema.library.ownerWorkspaceId, workspaceId),
    eq(schema.library.isPlatformLibrary, false),
    isNull(schema.library.deletedAt),
  );
}

