/**
 * The first half of creating a PDF asset: room in the bucket for the files.
 *
 * The wizard asks for this as soon as files are picked, redeems each ticket
 * it gets back (a presigned PUT or a Vercel Blob client token), and then posts the manifest to `createWorkspaceAsset`,
 * which confirms the objects exist before a row is written. Nothing is
 * recorded here: a batch nobody follows up on is a few objects under a
 * prefix the bucket's lifecycle rule expires (architecture.md 7), not a row.
 *
 * Keys are minted from ids and rooted in the workspace, so the create step
 * can tell a key this workspace was issued from any other by its prefix. The
 * console's platform uploads go through the same path under their own owner
 * segment (`preparePlatformUploads`).
 */
import { AppError } from '@/contracts/errors';
import { uuidv7 } from '@/lib/domain/id';
import {
  PLATFORM_UPLOAD_OWNER,
  UPLOAD_CONTENT_TYPES,
  uploadFileName,
  uploadKey,
  UPLOAD_LIMITS,
  type UploadSourceType,
} from '@/lib/domain/asset';
import {
  isObjectStoreConfigured,
  objectStore,
  type ObjectStore,
  type UploadTicket,
} from '@/lib/infrastructure/objects/store';
import { canManageAssets, type WorkspaceRole } from './delete';

export interface PrepareUploadsInput {
  workspaceId: string;
  role: WorkspaceRole;
  files: { name: string; size: number }[];
  /** A batch this workspace already started, so a second pick joins it. */
  batchId?: string;
  /** What is being uploaded; PDFs unless said otherwise. Decides the key and the content type. */
  kind?: UploadSourceType;
  store?: Pick<ObjectStore, 'uploadTicket'>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface PreparedUpload {
  id: string;
  name: string;
  size: number;
  /** How to send the bytes; valid for `UPLOAD_LIMITS.uploadUrlTtlSeconds`. */
  ticket: UploadTicket;
}

export async function prepareUploads(
  input: PrepareUploadsInput,
): Promise<{ batchId: string; files: PreparedUpload[] }> {
  if (!canManageAssets(input.role)) {
    throw new AppError('access_denied', 'only a workspace owner or admin can create an asset');
  }
  return prepareUploadTickets({
    owner: input.workspaceId,
    files: input.files,
    batchId: input.batchId,
    kind: input.kind,
    store: input.store,
  });
}

/**
 * The console's counterpart for a platform asset's PDFs. No role check:
 * the console action has already required the platform-assets capability,
 * and the keys are rooted in `PLATFORM_UPLOAD_OWNER`, a prefix no workspace
 * request can name.
 */
export async function preparePlatformUploads(input: {
  files: { name: string; size: number }[];
  batchId?: string;
  store?: Pick<ObjectStore, 'uploadTicket'>;
}): Promise<{ batchId: string; files: PreparedUpload[] }> {
  return prepareUploadTickets({ owner: PLATFORM_UPLOAD_OWNER, ...input });
}

async function prepareUploadTickets(input: {
  owner: string;
  files: { name: string; size: number }[];
  batchId?: string;
  kind?: UploadSourceType;
  store?: Pick<ObjectStore, 'uploadTicket'>;
}): Promise<{ batchId: string; files: PreparedUpload[] }> {
  const kind = input.kind ?? 'pdf';
  if (input.files.length === 0 || input.files.length > UPLOAD_LIMITS.maxFiles) {
    throw new AppError('invalid_request', `upload between 1 and ${UPLOAD_LIMITS.maxFiles} files`);
  }
  if (!input.store && !isObjectStoreConfigured()) {
    throw new AppError('provider_unavailable', 'no object storage is configured');
  }

  if (input.batchId !== undefined && !UUID.test(input.batchId)) {
    throw new AppError('invalid_request', 'the upload batch id is not valid');
  }
  const batchId = input.batchId ?? uuidv7();
  const store = input.store ?? objectStore();
  const files: PreparedUpload[] = [];
  for (const file of input.files) {
    const name = uploadFileName(file.name, kind);
    if (!name) throw new AppError('invalid_request', 'a file has no usable name');
    if (!Number.isInteger(file.size) || file.size <= 0 || file.size > UPLOAD_LIMITS.maxFileBytes) {
      throw new AppError('asset_size_exceeded', `${name} is empty or over the size limit`);
    }
    const id = uuidv7();
    files.push({
      id,
      name,
      size: file.size,
      ticket: await store.uploadTicket(uploadKey(input.owner, batchId, id, kind), {
        contentType: UPLOAD_CONTENT_TYPES[kind],
        maxBytes: UPLOAD_LIMITS.maxFileBytes,
        ttlSeconds: UPLOAD_LIMITS.uploadUrlTtlSeconds,
      }),
    });
  }
  return { batchId, files };
}
