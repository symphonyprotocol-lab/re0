/**
 * Files an asset carries beside its text: article images and episode audio.
 * agent-first-proposal.md 6.5, 6.6, 6.10, 8.1, 10.
 *
 * Uploads go straight from the browser to the private bucket on a ticket
 * (`prepareMediaUpload`), like every other upload (architecture.md 7), and
 * count only once confirmed: the object is checked to exist at the declared
 * size, hashed, and admitted against the workspace's remaining capacity in
 * one locked transaction. Uploading audio costs no Call; it only takes
 * capacity (proposal 8.2). A new episode file replaces the old one, which
 * stops counting and is removed from the bucket.
 *
 * Nothing is ever served from here as a download. A reader gets a
 * short-lived signed URL, issued per request, and only when they may read
 * the asset in full (`mediaUrlFor`): its owner, anyone for a free asset in a
 * public channel, a current subscriber for a paid one (`readableBy`). An
 * audio file is never sent to any third party (proposal 10).
 */
import { and, eq, ne, sql } from 'drizzle-orm';
import {
  audioContentType,
  AUDIO_TYPES,
  EDITORIAL_LIMITS,
  EditorialRefused,
  IMAGE_TYPES,
  imageContentType,
  mediaKey,
} from '@/lib/domain/editorial';
import { uuidv7 } from '@/lib/domain/id';
import { isObjectStoreConfigured, objectStore, type ObjectStore, type UploadTicket } from '@/lib/infrastructure/objects/store';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { readableBy } from '@/lib/application/channels/visibility';
import { workspaceStorage } from '@/lib/application/plans/storage';
import { ownedEditorialAsset, type EditorActor } from './assets';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function storeOrRefuse(store?: Pick<ObjectStore, 'uploadTicket' | 'head' | 'get' | 'delete' | 'signedUrl'>) {
  if (store) return store;
  if (!isObjectStoreConfigured()) throw new EditorialRefused('storage_unavailable', 'no object storage is configured');
  return objectStore();
}

export interface PreparedMedia {
  mediaId: string;
  ticket: UploadTicket;
  contentType: string;
}

/**
 * Room in the bucket for one image or one episode file. Refused up front
 * when the declared size would not fit what the workspace has left, so a
 * creator is not left uploading 100 MB that cannot be kept.
 */
export async function prepareMediaUpload(
  input: EditorActor & {
    assetId: string;
    kind: 'image' | 'audio';
    name: string;
    size: number;
    contentType: string;
    store?: Pick<ObjectStore, 'uploadTicket' | 'head' | 'get' | 'delete' | 'signedUrl'>;
  },
): Promise<PreparedMedia> {
  const database = db();
  const asset = await ownedEditorialAsset(database, input.workspaceId, input.assetId, input.kind === 'audio' ? ['audio', 'qa'] : ['post']);
  const contentType = input.kind === 'audio' ? audioContentType(input.contentType, input.name) : imageContentType(input.contentType);
  if (!contentType) throw new EditorialRefused('invalid_media', input.kind === 'audio' ? 'MP3, M4A or WAV only' : 'PNG, JPEG, WebP or GIF only');
  const maxBytes = input.kind === 'audio' ? EDITORIAL_LIMITS.audioMaxBytes : EDITORIAL_LIMITS.imageMaxBytes;
  if (!Number.isInteger(input.size) || input.size <= 0 || input.size > maxBytes) {
    throw new EditorialRefused('invalid_media', `the file is empty or over ${Math.round(maxBytes / 1_048_576)} MB`);
  }
  const storage = await workspaceStorage(input.workspaceId);
  if (input.size > storage.remainingBytes) {
    throw new EditorialRefused('storage_exceeded', `the workspace has ${storage.remainingBytes} bytes left`);
  }
  const store = storeOrRefuse(input.store);
  const mediaId = uuidv7();
  const extension = (input.kind === 'audio' ? AUDIO_TYPES : IMAGE_TYPES)[contentType] ?? 'bin';
  const objectKey = mediaKey(input.workspaceId, asset.id, mediaId, input.kind, extension);
  const ticket = await store.uploadTicket(objectKey, {
    contentType,
    maxBytes,
    ttlSeconds: EDITORIAL_LIMITS.uploadUrlTtlSeconds,
  });
  await database.insert(schema.assetMedia).values({
    id: mediaId,
    assetId: asset.id,
    workspaceId: input.workspaceId,
    kind: input.kind,
    objectKey,
    mime: contentType,
    bytes: input.size,
    state: 'pending',
  });
  return { mediaId, ticket, contentType };
}

async function sha256OfBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Admits an uploaded file: present at the declared size, hashed, and within
 * capacity -- checked again under the workspace lock, since another upload
 * may have landed since the ticket. An episode's previous file is replaced.
 */
export async function confirmMediaUpload(
  input: EditorActor & {
    mediaId: string;
    caption?: string | null;
    durationMs?: number | null;
    store?: Pick<ObjectStore, 'uploadTicket' | 'head' | 'get' | 'delete' | 'signedUrl'>;
  },
): Promise<{ mediaId: string; sha256: string; bytes: number }> {
  if (!UUID.test(input.mediaId)) throw new EditorialRefused('not_found', 'no such file');
  const store = storeOrRefuse(input.store);
  const database = db();
  const [media] = await database
    .select()
    .from(schema.assetMedia)
    .where(and(eq(schema.assetMedia.id, input.mediaId), eq(schema.assetMedia.workspaceId, input.workspaceId)));
  if (!media) throw new EditorialRefused('not_found', 'no such file');
  await ownedEditorialAsset(database, input.workspaceId, media.assetId, ['post', 'audio', 'qa']);
  if (media.state === 'ready' && media.sha256) return { mediaId: media.id, sha256: media.sha256, bytes: media.bytes };

  const head = await store.head(media.objectKey);
  if (!head) throw new EditorialRefused('not_uploaded', 'the file was not uploaded');
  if (head.size !== media.bytes) throw new EditorialRefused('not_uploaded', 'the file is not the size it was declared at');
  const bytes = await store.get(media.objectKey);
  if (!bytes || bytes.length !== media.bytes) throw new EditorialRefused('not_uploaded', 'the file could not be read back');
  const sha256 = await sha256OfBytes(bytes);
  const caption = input.caption?.trim().slice(0, 300) || null;
  const durationMs = Number.isInteger(input.durationMs) && (input.durationMs ?? 0) > 0 ? input.durationMs! : null;

  const replaced = await database.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`storage:${input.workspaceId}`}))`);
    const storage = await workspaceStorage(input.workspaceId, { executor: tx });
    /* A replaced episode file stops counting as this one starts. */
    const [previous] =
      media.kind === 'audio'
        ? await tx
            .select({ id: schema.assetMedia.id, bytes: schema.assetMedia.bytes, objectKey: schema.assetMedia.objectKey })
            .from(schema.assetMedia)
            .where(
              and(
                eq(schema.assetMedia.assetId, media.assetId),
                eq(schema.assetMedia.kind, 'audio'),
                eq(schema.assetMedia.state, 'ready'),
                ne(schema.assetMedia.id, media.id),
              ),
            )
            .for('update')
        : [];
    if (media.bytes > storage.remainingBytes + (previous?.bytes ?? 0)) {
      throw new EditorialRefused('storage_exceeded', `the workspace has ${storage.remainingBytes} bytes left`);
    }
    if (previous) await tx.update(schema.assetMedia).set({ state: 'replaced' }).where(eq(schema.assetMedia.id, previous.id));
    await tx
      .update(schema.assetMedia)
      .set({ state: 'ready', sha256, caption, durationMs })
      .where(eq(schema.assetMedia.id, media.id));
    return previous ?? null;
  });
  /* Best-effort: an object the bucket still holds costs storage, never correctness. */
  if (replaced) await store.delete(replaced.objectKey).catch(() => {});
  return { mediaId: media.id, sha256, bytes: media.bytes };
}

/** An image's caption, which is what the article's index carries in its place. */
export async function setImageCaption(input: EditorActor & { mediaId: string; caption: string }): Promise<void> {
  if (!UUID.test(input.mediaId)) throw new EditorialRefused('not_found', 'no such file');
  const updated = await db()
    .update(schema.assetMedia)
    .set({ caption: input.caption.trim().slice(0, 300) || null })
    .where(
      and(
        eq(schema.assetMedia.id, input.mediaId),
        eq(schema.assetMedia.workspaceId, input.workspaceId),
        eq(schema.assetMedia.kind, 'image'),
      ),
    )
    .returning({ id: schema.assetMedia.id });
  if (updated.length === 0) throw new EditorialRefused('not_found', 'no such image');
}

/**
 * A short-lived signed URL for one file, for a reader who may read its asset
 * in full right now -- or null, the same for "no such file" and "not yours to
 * read" (architecture.md 5.2). The asset must be live, except for its owner,
 * who previews their own drafts.
 */
export async function mediaUrlFor(
  viewerWorkspaceId: string | null,
  mediaId: string,
  store?: Pick<ObjectStore, 'signedUrl'>,
): Promise<{ url: string; kind: 'image' | 'audio'; mime: string } | null> {
  if (!UUID.test(mediaId)) return null;
  const [row] = await db()
    .select({
      objectKey: schema.assetMedia.objectKey,
      kind: schema.assetMedia.kind,
      mime: schema.assetMedia.mime,
      state: schema.assetMedia.state,
      readable: sql<boolean>`${readableBy(viewerWorkspaceId)}`,
    })
    .from(schema.assetMedia)
    .innerJoin(schema.asset, eq(schema.asset.id, schema.assetMedia.assetId))
    .where(
      and(
        eq(schema.assetMedia.id, mediaId),
        sql`${schema.asset.deletedAt} is null`,
        /* A draft's files are its owner's preview; everyone else waits for the publication. */
        viewerWorkspaceId
          ? sql`(${schema.asset.ownerWorkspaceId} = ${viewerWorkspaceId} or ${schema.asset.lifecycleStatus} = 'published')`
          : sql`${schema.asset.lifecycleStatus} = 'published'`,
      ),
    );
  if (!row || !row.readable || row.state !== 'ready') return null;
  const signer = store ?? (isObjectStoreConfigured() ? objectStore() : null);
  if (!signer) return null;
  const ttl = row.kind === 'audio' ? EDITORIAL_LIMITS.audioUrlTtlSeconds : EDITORIAL_LIMITS.imageUrlTtlSeconds;
  return { url: await signer.signedUrl(row.objectKey, ttl), kind: row.kind, mime: row.mime };
}
