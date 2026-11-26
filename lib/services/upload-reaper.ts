/**
 * `/api/cron/purge-uploads` (daily, idempotent): files a browser uploaded
 * with a token from `/api/upload-token` but never registered — a knowledge
 * file no `knowledge.source` names, an avatar no user, Ree or setup draft
 * names, a cover no Ree names, a post image no post names, and anything the
 * removed agent workspace left under `workspace/` — are deleted once older than
 * UPLOAD_ORPHAN_HOURS. Unregistered files are never billed for storage, so
 * this is what keeps them from accumulating. A replaced avatar or cover is
 * unreferenced too and goes the same way.
 *
 * A store may serve several environments: a file is this database's to
 * delete only when its owning user (or, for covers, Ree) exists here.
 */
import { inArray, sql } from 'drizzle-orm';
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
     * The agent workspace's objects (file contents and upload parts), left
     * when migration 0101 dropped the workspace on 2026-11-26. Nothing names
     * them any more, so all of them go, but only once this database no
     * longer has the workspace tables: a database that refused the drop, or
     * has not run it yet, keeps them. Last in the list, so it never takes
     * the budget from the others. Remove this entry once a run reports 0
     * here and `workspace/` lists nothing.
     */
    prefix: 'workspace/',
    owner: /^workspace\/([^/]+)\//,
    async known(ids) {
      const rows = await db().execute<{ gone: boolean }>(sql`select to_regclass('public.agent_workspace') is null as gone`);
      return rows.rows[0]?.gone ? new Set(ids) : new Set();
    },
    async referenced() {
      return new Set();
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
