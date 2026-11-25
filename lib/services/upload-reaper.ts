/**
 * `/api/cron/purge-uploads` (daily, idempotent): files a browser uploaded
 * with a token from `/api/upload-token` but never registered — a knowledge
 * file no `knowledge.source` names, an avatar no user, Ree or setup draft
 * names, a cover no Ree names, a post image no post names, a workspace object no
 * version counts — are deleted once older than
 * UPLOAD_ORPHAN_HOURS. Unregistered files are never billed for storage, so
 * this is what keeps them from accumulating. A replaced avatar or cover is
 * unreferenced too and goes the same way.
 *
 * A store may serve several environments: a file is this database's to
 * delete only when its owning user (or, for covers, Ree) exists here.
 */
import { and, inArray, sql } from 'drizzle-orm';
import { UPLOAD_ORPHAN_HOURS, UPLOAD_REAP_BATCH, UPLOAD_REAP_SCAN } from '@/lib/constants';
import { deleteBlobs, listByPrefix } from '@/lib/infra/blob-access';
import { db, schema } from '@/lib/infra/db';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

interface Prefix {
  prefix: string;
  /** The owning id (user or Ree) in an upload pathname of this prefix, or null for anything else. */
  owner: RegExp;
  /** Of these owner ids, the ones that exist in this database. */
  known(ids: string[]): Promise<Set<string>>;
  /** Of these pathnames, the ones something here still names. */
  referenced(pathnames: string[]): Promise<Set<string>>;
}

async function knownUsers(ids: string[]): Promise<Set<string>> {
  const rows = await db().select({ id: schema.user.id }).from(schema.user).where(inArray(schema.user.id, ids));
  return new Set(rows.map((row) => row.id));
}

const PREFIXES: Prefix[] = [
  {
    prefix: 'knowledge/',
    owner: new RegExp(`^knowledge/(${UUID})/${UUID}/[^/]+$`),
    known: knownUsers,
    async referenced(pathnames) {
      /* Trashed knowledge keeps its file until the trash purge deletes both. */
      const rows = await db().select({ source: schema.knowledge.source }).from(schema.knowledge).where(inArray(schema.knowledge.source, pathnames));
      return new Set(rows.map((row) => row.source!));
    },
  },
  {
    prefix: 'avatars/',
    owner: new RegExp(`^avatars/(${UUID})/${UUID}\\.(?:jpg|png|webp)$`),
    known: knownUsers,
    async referenced(pathnames) {
      const list = sql.join(pathnames.map((pathname) => sql`${pathname}`), sql`, `);
      const rows = await db().execute<{ pathname: string }>(sql`
        select avatar_blob as pathname from ${schema.user} where avatar_blob in (${list})
        union select avatar_blob from ${schema.ree} where avatar_blob in (${list})
        union select ree_draft ->> 'avatarBlob' from ${schema.user} where ree_draft ->> 'avatarBlob' in (${list})`);
      return new Set(rows.rows.map((row) => row.pathname));
    },
  },
  {
    prefix: 'ree-covers/',
    owner: new RegExp(`^ree-covers/(${UUID})/${UUID}\\.(?:jpg|png|webp)$`),
    async known(ids) {
      const rows = await db().select({ id: schema.ree.id }).from(schema.ree).where(inArray(schema.ree.id, ids));
      return new Set(rows.map((row) => row.id));
    },
    async referenced(pathnames) {
      const rows = await db().select({ coverBlob: schema.ree.coverBlob }).from(schema.ree).where(inArray(schema.ree.coverBlob, pathnames));
      return new Set(rows.map((row) => row.coverBlob!));
    },
  },
  {
    /* A post's image (or its `.thumb.jpg`) the composer uploaded but no post names (abandoned, or its post purged): post_image rows keep the rest. */
    prefix: 'post-images/',
    owner: new RegExp(`^post-images/(${UUID})/${UUID}\\.(?:jpg|png|webp|thumb\\.jpg)$`),
    known: knownUsers,
    async referenced(pathnames) {
      const list = sql.join(pathnames.map((pathname) => sql`${pathname}`), sql`, `);
      const rows = await db().execute<{ pathname: string }>(sql`
        select pathname from ${schema.postImage} where pathname in (${list})
        union select thumb_pathname from ${schema.postImage} where thumb_pathname in (${list})`);
      return new Set(rows.rows.map((row) => row.pathname));
    },
  },
  {
    /*
     * An agent workspace object whose write rolled back after the put
     * (workspace.ts puts under the owner's usage lock, inside the write's
     * transaction): no `agent_workspace_blob` row names it. A later write of the
     * same content puts it again, so only the instant between this check and
     * the delete could lose one, a day after the failed write. A deleted
     * workspace's objects go the same way, by its tombstone.
     */
    prefix: 'workspace/',
    owner: new RegExp(`^workspace/(${UUID})/[0-9a-f]{64}$`),
    async known(ids) {
      /* A workspace deleted here (its owner's account) left a tombstone: its objects are ours to remove, and nothing names them. */
      const [live, gone] = await Promise.all([
        db().select({ id: schema.workspace.id }).from(schema.workspace).where(inArray(schema.workspace.id, ids)),
        db().select({ id: schema.workspaceGone.workspaceId }).from(schema.workspaceGone).where(inArray(schema.workspaceGone.workspaceId, ids)),
      ]);
      return new Set([...live, ...gone].map((row) => row.id));
    },
    async referenced(pathnames) {
      const pairs = pathnames.map((pathname) => pathname.split('/'));
      const list = sql.join(pairs.map(([, workspaceId, sha]) => sql`(${workspaceId}::uuid, ${sha})`), sql`, `);
      const rows = await db().execute<{ workspace_id: string; sha256: string }>(sql`
        select workspace_id, sha256 from ${schema.workspaceBlob} where (workspace_id, sha256) in (${list})`);
      return new Set(rows.rows.map((row) => `workspace/${row.workspace_id}/${row.sha256}`));
    },
  },
  {
    /*
     * A part (or the half-stitched object) of a workspace upload that is no
     * longer taking parts or being put together: done, failed, expired and
     * forgotten, or a part that came in after the upload ended. An upload
     * still open or being stitched keeps its objects.
     */
    prefix: 'workspace/',
    owner: new RegExp(`^workspace/(${UUID})/upload/${UUID}/(?:[0-9]+|assembled(?:\\.[0-9]+)?)$`),
    async known(ids) {
      const [live, gone] = await Promise.all([
        db().select({ id: schema.workspace.id }).from(schema.workspace).where(inArray(schema.workspace.id, ids)),
        db().select({ id: schema.workspaceGone.workspaceId }).from(schema.workspaceGone).where(inArray(schema.workspaceGone.workspaceId, ids)),
      ]);
      return new Set([...live, ...gone].map((row) => row.id));
    },
    async referenced(pathnames) {
      const uploads = [...new Set(pathnames.map((pathname) => pathname.split('/')[3]!))];
      const rows = await db()
        .select({ id: schema.workspaceUpload.id })
        .from(schema.workspaceUpload)
        .where(and(inArray(schema.workspaceUpload.id, uploads), inArray(schema.workspaceUpload.status, ['open', 'assembling'])));
      const busy = new Set(rows.map((row) => row.id));
      return new Set(pathnames.filter((pathname) => busy.has(pathname.split('/')[3]!)));
    },
  },
];

export async function purgeOrphanUploads(now = new Date()): Promise<Record<string, number>> {
  const before = now.getTime() - UPLOAD_ORPHAN_HOURS * 60 * 60 * 1000;
  const removed: Record<string, number> = {};
  let budget = UPLOAD_REAP_BATCH;
  for (const { prefix, owner, known, referenced } of PREFIXES) {
    removed[prefix] = 0;
    let cursor: string | undefined;
    let seen = 0;
    do {
      const page = await listByPrefix(prefix, { cursor, limit: 1000 });
      seen += page.blobs.length;
      const old = page.blobs
        .filter((blob) => blob.uploadedAt.getTime() < before)
        .flatMap((blob) => {
          const id = owner.exec(blob.pathname)?.[1];
          return id ? [{ pathname: blob.pathname, id }] : [];
        });
      if (old.length) {
        const [ours, kept] = await Promise.all([known([...new Set(old.map((blob) => blob.id))]), referenced(old.map((blob) => blob.pathname))]);
        const orphans = old.filter((blob) => ours.has(blob.id) && !kept.has(blob.pathname)).map((blob) => blob.pathname).slice(0, budget);
        await deleteBlobs(orphans);
        removed[prefix] += orphans.length;
        budget -= orphans.length;
      }
      cursor = page.cursor ?? undefined;
    } while (cursor && budget > 0 && seen < UPLOAD_REAP_SCAN);
    if (budget <= 0) break;
  }
  return removed;
}
