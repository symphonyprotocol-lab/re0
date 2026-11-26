/**
 * Publishing a file's original (docs/design/agent-workspace-p4.md §2): one
 * version of one workspace file, pinned, at `/f/<public_id>` for anyone with
 * the link. Only the owner, only on the web -- no MCP tool publishes, so an
 * agent talked into it by a file cannot. Before a version goes out it passes
 * the checks of lib/domain/publish.ts (type, active content, image bytes,
 * secrets), the account's eligibility, the console's ceilings and the
 * takedown blocklist; "update to the current version" passes them again.
 *
 * Every download goes through the function (`serveDownload`): it is counted
 * (per file and day, per account and month), billed past the free volume by
 * the daily storage charge, limited per address, per file and per account a
 * day, and refused at once when the publication is no longer live -- nothing
 * is cached at the CDN to purge. A file over WORKSPACE_DOWNLOAD_INLINE_MAX is
 * a 302 to a signed store URL only once PUBLISH_BLOB_REDIRECT is on (R4);
 * until then nothing larger can be published.
 *
 * A link is unavailable (not revoked) while its file is in the trash, its
 * owner disabled, in debt past the console's limit or frozen by an
 * administrator, or reports suspended it; revoked links are gone for good,
 * and look exactly like ids that never existed.
 */
import { createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { and, desc, eq, gte, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import {
  PUBLISH_ACCOUNT_MIN_AGE_MS,
  PUBLISH_BLOB_REDIRECT,
  PUBLISH_DOWNLOADS_PER_IP_HOUR,
  PUBLISH_ID_LENGTH,
  PUBLISH_PDF_INFLATE_MAX,
  PUBLISH_PREVIEW_BYTES,
  PUBLISH_PREVIEW_LINES,
  PUBLISH_REPORT_SUSPEND,
  PUBLISH_REPORT_WINDOW_MS,
  PUBLISH_REPORTS_PER_IP_HOUR,
  PUBLISH_TITLE_MAX,
  WORKSPACE_DOCX_INFLATE_MAX,
  WORKSPACE_DOWNLOAD_INLINE_MAX,
  WORKSPACE_PARSE_MS,
} from '@/lib/constants';
import { attachmentDisposition, cleanTitle, officeVerdict, pdfActiveContent, previewOf, publishTypeOf, strictText, type PublishCheck } from '@/lib/domain/publish';
import { nameOf, scanSecrets } from '@/lib/domain/workspace';
import { pdfTextLayer } from '@/lib/infra/connectors/pdf';
import { authSecret } from '@/lib/infra/crypto/secrets';
import { db, schema, type Tx } from '@/lib/infra/db';
import { openWorkspaceObject, readWorkspaceObject, signedObjectUrl, workspaceObjectPath } from '@/lib/infra/workspace-store';
import { appBaseUrl } from '@/lib/http/cookies';
import { audit } from '@/lib/services/admin';
import { notify } from '@/lib/services/notices';
import { hitRateBucket } from '@/lib/services/rate-limit';
import { effectiveCeiling } from '@/lib/services/rate-limit-settings';
import { imageMatches } from '@/lib/services/workspace-resources';
import { debtOf, existing, lockUsage, resolvePath, shown, WorkspaceError, type WorkspaceScope } from '@/lib/services/workspace';

const MB = 1024 * 1024;
type Publication = typeof schema.workspacePublication.$inferSelect;

export class PublishError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'PublishError';
  }
}

export const publicUrl = (publicId: string) => `${appBaseUrl()}/f/${publicId}`;

function newPublicId(): string {
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let id = '';
  while (id.length < PUBLISH_ID_LENGTH) {
    for (const byte of randomBytes(PUBLISH_ID_LENGTH * 2)) {
      /* 62 * 4 = 248: bytes at or above it are dropped, so every character is equally likely. */
      if (byte < 248 && id.length < PUBLISH_ID_LENGTH) id += alphabet[byte % 62];
    }
  }
  return id;
}

const isPublicId = (value: string) => new RegExp(`^[0-9A-Za-z]{${PUBLISH_ID_LENGTH}}$`).test(value);

/** The largest file that may be published now: the console's, but never past one function response until the redirect is on. */
async function sizeCap(): Promise<number> {
  const configured = (await effectiveCeiling('publishFileMaxMb')) * MB;
  return PUBLISH_BLOB_REDIRECT ? configured : Math.min(configured, WORKSPACE_DOWNLOAD_INLINE_MAX);
}

/* ------------------------------------------------------------------ checks */

interface Prepared {
  version: { entryId: string; path: string; revision: string; sha: string; size: number; createdAt: Date };
  mediaType: string;
  checks: PublishCheck[];
  preview: string | null;
}

/** Who may publish (§2.4, Q5): an account a week old, not disabled, owing nothing for storage, not frozen; and under the live-file ceiling. */
async function accountChecks(userId: string, now: Date, excluding?: string): Promise<PublishCheck[]> {
  const [account] = await db().select({ createdAt: schema.user.createdAt, disabledAt: schema.user.disabledAt }).from(schema.user).where(eq(schema.user.id, userId));
  const [usage] = await db().select({ frozen: schema.workspaceUsage.publishFrozenAt }).from(schema.workspaceUsage).where(eq(schema.workspaceUsage.userId, userId));
  const owed = await debtOf(userId);
  const checks: PublishCheck[] = [];
  if (!account || account.disabledAt) checks.push({ key: 'account', ok: false, detail: 'disabled' });
  else if (now.getTime() - account.createdAt.getTime() < PUBLISH_ACCOUNT_MIN_AGE_MS) checks.push({ key: 'account', ok: false, detail: 'too_new' });
  else if (usage?.frozen) checks.push({ key: 'account', ok: false, detail: 'frozen' });
  else if (owed > 0) checks.push({ key: 'account', ok: false, detail: 'debt' });
  else checks.push({ key: 'account', ok: true });
  const max = await effectiveCeiling('publishMaxFiles');
  const [{ live } = { live: 0 }] = await db()
    .select({ live: sql<number>`count(*)::int` })
    .from(schema.workspacePublication)
    .where(and(eq(schema.workspacePublication.ownerId, userId), isNull(schema.workspacePublication.revokedAt), excluding ? sql`${schema.workspacePublication.id} <> ${excluding}` : sql`true`));
  checks.push(live < max ? { key: 'count', ok: true, detail: String(max - live) } : { key: 'count', ok: false, detail: String(max) });
  return checks;
}

/** A PDF's text (for the secret scan and the preview), or null when it has no text layer the parser can read in time. */
async function pdfText(bytes: Uint8Array): Promise<string | null> {
  try {
    const layer = await pdfTextLayer(bytes, { deadline: Date.now() + WORKSPACE_PARSE_MS });
    return 'sections' in layer ? layer.sections.map((section) => section.text).join('\n\n') : null;
  } catch {
    return null;
  }
}

/** One version of a file, checked from its bytes: what the dialog lists, and the preview the public page would show. */
async function prepare(scope: WorkspaceScope, rawPath: unknown, revision: string | undefined, now: Date, excluding?: string): Promise<Prepared> {
  const path = resolvePath(scope, rawPath);
  const entry = await existing(db(), scope, path);
  if (entry.kind === 'folder') throw new WorkspaceError('is_a_directory', `${shown(scope, path)} is a folder; publish one file at a time.`, { path: shown(scope, path) });
  let version: Prepared['version'] = { entryId: entry.id, path: entry.path, revision: entry.currentRevisionId!, sha: entry.sha256!, size: entry.size, createdAt: entry.updatedAt };
  if (revision && revision !== entry.currentRevisionId) {
    const [found] = /^[0-9a-f-]{36}$/i.test(revision)
      ? await db().select().from(schema.workspaceRevision).where(and(eq(schema.workspaceRevision.id, revision), eq(schema.workspaceRevision.entryId, entry.id)))
      : [];
    if (!found) throw new WorkspaceError('not_found', 'No such version of this file.', { revision });
    version = { entryId: entry.id, path: entry.path, revision: found.id, sha: found.sha256, size: found.size, createdAt: found.createdAt };
  }
  const checks: PublishCheck[] = [];
  const type = publishTypeOf(entry.path);
  checks.push(type ? { key: 'type', ok: true, detail: type.extension } : { key: 'type', ok: false, detail: entry.path.includes('.') ? entry.path.slice(entry.path.lastIndexOf('.') + 1).toLowerCase() : '' });
  const cap = await sizeCap();
  checks.push(version.size <= cap ? { key: 'size', ok: true, detail: String(cap) } : { key: 'size', ok: false, detail: String(cap) });
  checks.push(...(await accountChecks(scope.userId, now, excluding)));
  const [blocked] = await db().select({ sha: schema.publishBlock.sha256 }).from(schema.publishBlock).where(eq(schema.publishBlock.sha256, version.sha));
  checks.push({ key: 'blocked', ok: !blocked });
  let preview: string | null = null;
  /* The bytes are read only for a file that could go out at all. */
  if (type && version.size <= cap && !blocked) {
    const bytes = await readWorkspaceObject(workspaceObjectPath(scope.workspaceId, version.sha));
    if (!bytes) throw new WorkspaceError('not_found', 'This version’s bytes are missing.', { revision: version.revision });
    let text: string | null = null;
    if (type.category === 'text') {
      text = strictText(bytes);
      checks.push({ key: 'text', ok: text !== null });
    } else if (type.category === 'pdf') {
      const active = pdfActiveContent(bytes, PUBLISH_PDF_INFLATE_MAX);
      checks.push(active ? { key: 'active_content', ok: false, detail: active } : { key: 'active_content', ok: true });
      if (!active) text = await pdfText(bytes);
    } else if (type.category === 'office') {
      const verdict = await officeVerdict(bytes, WORKSPACE_DOCX_INFLATE_MAX);
      checks.push(verdict.active ? { key: 'active_content', ok: false, detail: verdict.active } : { key: 'active_content', ok: true });
      text = verdict.active ? null : verdict.text;
    } else {
      checks.push(imageMatches(type.mediaType, bytes) ? { key: 'image', ok: true } : { key: 'image', ok: false, detail: type.mediaType });
    }
    if (text !== null) {
      const secret = scanSecrets(text);
      checks.push(secret ? { key: 'secrets', ok: false, detail: secret } : { key: 'secrets', ok: true });
      preview = previewOf(text, PUBLISH_PREVIEW_LINES, PUBLISH_PREVIEW_BYTES) || null;
    } else if (type.category !== 'image') {
      /* A document with no text layer (a scan) has nothing to scan or preview. */
      checks.push({ key: 'secrets', ok: true, detail: 'no_text' });
    }
  }
  return { version, mediaType: type?.mediaType ?? 'application/octet-stream', checks, preview };
}

const passed = (checks: readonly PublishCheck[]) => checks.every((check) => check.ok);

function refusal(checks: readonly PublishCheck[]): PublishError {
  return new PublishError(422, 'checks_failed', 'This version cannot be published; the checks say why.', { checks });
}

/** What the dialog shows before anything is published: the version, and every check with its verdict. */
export async function publishCheck(scope: WorkspaceScope, input: { path: string; revision?: string }, now = new Date()) {
  const live = await liveFor(scope, input.path);
  const prepared = await prepare(scope, input.path, input.revision, now, live?.id);
  return {
    path: shown(scope, prepared.version.path),
    file_name: nameOf(prepared.version.path),
    revision: prepared.version.revision,
    size: prepared.version.size,
    media_type: prepared.mediaType,
    checks: prepared.checks,
    ok: passed(prepared.checks),
    published: live ? viewOf(live) : null,
  };
}

/* ------------------------------------------------------------------ the owner */

export interface PublicationView {
  id: string;
  public_id: string;
  url: string;
  file_name: string;
  title: string;
  size: number;
  media_type: string;
  revision: string;
  indexable: boolean;
  created_at: Date;
  updated_at: Date;
  suspended: boolean;
  revoked: boolean;
}

function viewOf(row: Publication): PublicationView {
  return {
    id: row.id,
    public_id: row.publicId,
    url: publicUrl(row.publicId),
    file_name: row.fileName,
    title: row.title,
    size: row.size,
    media_type: row.mediaType,
    revision: row.revisionId,
    indexable: row.indexable,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    suspended: row.suspendedAt !== null,
    revoked: row.revokedAt !== null,
  };
}

/** The live publication of the file at `rawPath` in the scope, if any. */
async function liveFor(scope: WorkspaceScope, rawPath: unknown): Promise<Publication | null> {
  const path = resolvePath(scope, rawPath);
  const entry = await existing(db(), scope, path);
  const [row] = await db()
    .select()
    .from(schema.workspacePublication)
    .where(and(eq(schema.workspacePublication.entryId, entry.id), isNull(schema.workspacePublication.revokedAt)));
  return row ?? null;
}

/** For the file page and `ws_stat`: the live publication of one entry, with what it was downloaded in the last 30 days. */
export async function publicationOfEntry(entryId: string, now = new Date()) {
  const [row] = await db()
    .select()
    .from(schema.workspacePublication)
    .where(and(eq(schema.workspacePublication.entryId, entryId), isNull(schema.workspacePublication.revokedAt)));
  if (!row) return null;
  const since = new Date(now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
  const [stats = { downloads: 0, bytes: 0 }] = await db()
    .select({ downloads: sql<number>`coalesce(sum(${schema.workspacePublicationDay.downloads}), 0)::int`, bytes: sql<number>`coalesce(sum(${schema.workspacePublicationDay.bytes}), 0)::bigint` })
    .from(schema.workspacePublicationDay)
    .where(and(eq(schema.workspacePublicationDay.publicationId, row.id), gte(schema.workspacePublicationDay.day, since)));
  return { ...viewOf(row), downloads_30d: Number(stats.downloads), bytes_30d: Number(stats.bytes) };
}

async function ownPublication(scope: WorkspaceScope, id: string): Promise<Publication> {
  const [row] = /^[0-9a-f-]{36}$/i.test(id)
    ? await db()
        .select()
        .from(schema.workspacePublication)
        .where(and(eq(schema.workspacePublication.id, id), eq(schema.workspacePublication.ownerId, scope.userId), eq(schema.workspacePublication.workspaceId, scope.workspaceId), isNull(schema.workspacePublication.revokedAt)))
    : [];
  if (!row) throw new PublishError(404, 'not_found', 'No such public file.');
  return row;
}

/** Publishes one version (the current one by default) of a file; a file already public is updated instead with `updatePublication`. */
export async function publishFile(scope: WorkspaceScope, input: { path: string; revision?: string; title?: unknown; indexable?: boolean }, now = new Date()): Promise<PublicationView> {
  if (scope.access !== 'write' || scope.apiKeyId !== null) throw new PublishError(403, 'forbidden', 'Only the owner publishes, on the web.');
  if (await liveFor(scope, input.path)) throw new PublishError(409, 'already_published', 'This file is already public; update or stop its publication instead.');
  const prepared = await prepare(scope, input.path, input.revision, now);
  if (!passed(prepared.checks)) throw refusal(prepared.checks);
  const title = cleanTitle(input.title, PUBLISH_TITLE_MAX) ?? cleanTitle(nameOf(prepared.version.path), PUBLISH_TITLE_MAX)!;
  try {
    const [row] = await db()
      .insert(schema.workspacePublication)
      .values({
        publicId: newPublicId(),
        workspaceId: scope.workspaceId,
        ownerId: scope.userId,
        entryId: prepared.version.entryId,
        revisionId: prepared.version.revision,
        sha256: prepared.version.sha,
        size: prepared.version.size,
        mediaType: prepared.mediaType,
        fileName: nameOf(prepared.version.path),
        title,
        indexable: input.indexable === true,
        preview: prepared.preview,
        checks: prepared.checks,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return viewOf(row!);
  } catch (error) {
    /* Two publishes of one file at once: the partial unique index lets one through. */
    if ((error as { code?: string }).code === '23505') throw new PublishError(409, 'already_published', 'This file is already public.');
    throw error;
  }
}

/** Points the link at the file's current version (checked again), and/or changes its title or indexing; the URL stays. */
export async function updatePublication(scope: WorkspaceScope, id: string, input: { toCurrent?: boolean; title?: unknown; indexable?: boolean }, now = new Date()): Promise<PublicationView> {
  if (scope.access !== 'write' || scope.apiKeyId !== null) throw new PublishError(403, 'forbidden', 'Only the owner publishes, on the web.');
  const row = await ownPublication(scope, id);
  const set: Partial<typeof schema.workspacePublication.$inferInsert> = { updatedAt: now };
  if (input.title !== undefined) {
    const title = cleanTitle(input.title, PUBLISH_TITLE_MAX);
    if (!title) throw new PublishError(400, 'invalid_title', 'A title needs some text.');
    set.title = title;
  }
  if (typeof input.indexable === 'boolean') set.indexable = input.indexable;
  if (input.toCurrent) {
    const [entry] = row.entryId ? await db().select().from(schema.workspaceEntry).where(eq(schema.workspaceEntry.id, row.entryId)) : [];
    if (!entry || entry.deletedAt) throw new PublishError(409, 'file_gone', 'The file is in the trash; restore it first.');
    const prepared = await prepare(scope, shown(scope, entry.path), undefined, now, row.id);
    if (!passed(prepared.checks)) throw refusal(prepared.checks);
    Object.assign(set, {
      revisionId: prepared.version.revision,
      sha256: prepared.version.sha,
      size: prepared.version.size,
      mediaType: prepared.mediaType,
      fileName: nameOf(prepared.version.path),
      preview: prepared.preview,
      checks: prepared.checks,
    });
  }
  const [updated] = await db().update(schema.workspacePublication).set(set).where(and(eq(schema.workspacePublication.id, row.id), isNull(schema.workspacePublication.revokedAt))).returning();
  if (!updated) throw new PublishError(404, 'not_found', 'No such public file.');
  return viewOf(updated);
}

/** Stops publishing: the link is gone at once, for good. */
export async function unpublish(scope: WorkspaceScope, id: string, now = new Date()): Promise<void> {
  const row = await ownPublication(scope, id);
  await db()
    .update(schema.workspacePublication)
    .set({ revokedAt: now, revokeReason: 'owner', updatedAt: now })
    .where(and(eq(schema.workspacePublication.id, row.id), isNull(schema.workspacePublication.revokedAt)));
}

/** The owner's live public files, newest first, with their path (or null when in the trash) and 30 days of downloads. */
export async function publicationsOf(scope: WorkspaceScope, now = new Date()) {
  const since = new Date(now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
  const rows = await db()
    .select({
      row: schema.workspacePublication,
      path: schema.workspaceEntry.path,
      deletedAt: schema.workspaceEntry.deletedAt,
      current: schema.workspaceEntry.currentRevisionId,
      downloads: sql<number>`(select coalesce(sum(d.downloads), 0)::int from ${schema.workspacePublicationDay} d where d.publication_id = ${schema.workspacePublication.id} and d.day >= ${since})`,
      bytes: sql<number>`(select coalesce(sum(d.bytes), 0)::bigint from ${schema.workspacePublicationDay} d where d.publication_id = ${schema.workspacePublication.id} and d.day >= ${since})`,
    })
    .from(schema.workspacePublication)
    .leftJoin(schema.workspaceEntry, eq(schema.workspaceEntry.id, schema.workspacePublication.entryId))
    .where(and(eq(schema.workspacePublication.ownerId, scope.userId), eq(schema.workspacePublication.workspaceId, scope.workspaceId), isNull(schema.workspacePublication.revokedAt)))
    .orderBy(desc(schema.workspacePublication.createdAt));
  return rows.map(({ row, path, deletedAt, current, downloads, bytes }) => ({
    ...viewOf(row),
    path: path && !deletedAt ? shown(scope, path) : null,
    trashed: Boolean(deletedAt),
    stale: current !== null && current !== row.revisionId,
    downloads_30d: Number(downloads),
    bytes_30d: Number(bytes),
  }));
}

/* ------------------------------------------------------------------ the public */

export type Availability = 'live' | 'trashed' | 'suspended' | 'owner_unavailable' | 'daily_limit';

interface Loaded {
  row: Publication;
  availability: Availability;
  owner: { id: string; name: string; handle: string | null };
}

/** A public id's live publication and whether it can be served now; null for one that never existed or was revoked (the same answer). */
async function load(publicId: string, now: Date): Promise<Loaded | null> {
  if (!isPublicId(publicId)) return null;
  const [found] = await db()
    .select({ row: schema.workspacePublication, deletedAt: schema.workspaceEntry.deletedAt, owner: { id: schema.user.id, name: schema.user.name, handle: schema.user.providerHandle, disabledAt: schema.user.disabledAt }, frozen: schema.workspaceUsage.publishFrozenAt })
    .from(schema.workspacePublication)
    .innerJoin(schema.user, eq(schema.user.id, schema.workspacePublication.ownerId))
    .leftJoin(schema.workspaceEntry, eq(schema.workspaceEntry.id, schema.workspacePublication.entryId))
    .leftJoin(schema.workspaceUsage, eq(schema.workspaceUsage.userId, schema.workspacePublication.ownerId))
    .where(and(eq(schema.workspacePublication.publicId, publicId), isNull(schema.workspacePublication.revokedAt)));
  if (!found) return null;
  const owner = { id: found.owner.id, name: found.owner.name, handle: found.owner.handle };
  if (found.deletedAt || !found.row.entryId) return { row: found.row, availability: 'trashed', owner };
  if (found.row.suspendedAt) return { row: found.row, availability: 'suspended', owner };
  if (found.owner.disabledAt || found.frozen) return { row: found.row, availability: 'owner_unavailable', owner };
  if ((await debtOf(found.row.ownerId)) > (await effectiveCeiling('workspaceDebtLimit'))) return { row: found.row, availability: 'owner_unavailable', owner };
  if (await overDaily(found.row, now)) return { row: found.row, availability: 'daily_limit', owner };
  return { row: found.row, availability: 'live', owner };
}

const dayOf = (now: Date) => now.toISOString().slice(0, 10);
const monthOf = (now: Date) => `${now.toISOString().slice(0, 7)}-01`;

/** Whether another download would pass today's volume for this file or for its owner's account. */
async function overDaily(row: Publication, now: Date): Promise<boolean> {
  const today = dayOf(now);
  const [file] = await db()
    .select({ bytes: schema.workspacePublicationDay.bytes })
    .from(schema.workspacePublicationDay)
    .where(and(eq(schema.workspacePublicationDay.publicationId, row.id), eq(schema.workspacePublicationDay.day, today)));
  if ((file?.bytes ?? 0) + row.size > (await effectiveCeiling('publishFileDailyMb')) * MB) return true;
  const [usage] = await db().select({ day: schema.workspaceUsage.egressDay, bytes: schema.workspaceUsage.egressDayBytes }).from(schema.workspaceUsage).where(eq(schema.workspaceUsage.userId, row.ownerId));
  const spent = usage?.day === today ? usage.bytes : 0;
  return spent + row.size > (await effectiveCeiling('publishDailyMb')) * MB;
}

export interface PublicFileView {
  publicId: string;
  title: string;
  fileName: string;
  mediaType: string;
  size: number;
  sha256: string;
  publishedAt: Date;
  versionAt: Date;
  updatedAt: Date;
  indexable: boolean;
  preview: string | null;
  image: boolean;
  availability: Availability;
  owner: { name: string; handle: string | null };
  /** Public, published Rees that cite this file, for the "ask it" card. */
  rees: { slug: string; name: string }[];
}

/** What `/f/<id>` shows; null for an id that never existed or was revoked. */
export async function publicFile(publicId: string, now = new Date()): Promise<PublicFileView | null> {
  const loaded = await load(publicId, now);
  if (!loaded) return null;
  const { row } = loaded;
  const [revision] = await db().select({ createdAt: schema.workspaceRevision.createdAt }).from(schema.workspaceRevision).where(eq(schema.workspaceRevision.id, row.revisionId));
  const rees = row.entryId
    ? await db()
        .selectDistinct({ slug: schema.ree.slug, name: schema.ree.name })
        .from(schema.knowledge)
        .innerJoin(schema.ree, eq(schema.ree.id, schema.knowledge.reeId))
        .where(and(eq(schema.knowledge.workspaceEntryId, row.entryId), isNull(schema.knowledge.deletedAt), eq(schema.knowledge.enabled, true), eq(schema.ree.isPublic, true), eq(schema.ree.isPublished, true), isNull(schema.ree.moderatedAt), isNull(schema.ree.deletedAt)))
        .limit(3)
    : [];
  return {
    publicId: row.publicId,
    title: row.title,
    fileName: row.fileName,
    mediaType: row.mediaType,
    size: row.size,
    sha256: row.sha256,
    publishedAt: row.createdAt,
    versionAt: revision?.createdAt ?? row.updatedAt,
    updatedAt: row.updatedAt,
    indexable: row.indexable,
    preview: row.preview,
    image: row.mediaType.startsWith('image/'),
    availability: loaded.availability,
    owner: { name: loaded.owner.name, handle: loaded.owner.handle },
    rees: rees.filter((ree): ree is { slug: string; name: string } => Boolean(ree.slug)),
  };
}

/** A page view of a live public file, for the owner's figures. */
export async function countPageView(publicId: string, now = new Date()): Promise<void> {
  if (!isPublicId(publicId)) return;
  const [row] = await db().select({ id: schema.workspacePublication.id }).from(schema.workspacePublication).where(and(eq(schema.workspacePublication.publicId, publicId), isNull(schema.workspacePublication.revokedAt)));
  if (!row) return;
  await db()
    .insert(schema.workspacePublicationDay)
    .values({ publicationId: row.id, day: dayOf(now), pageViews: 1 })
    .onConflictDoUpdate({ target: [schema.workspacePublicationDay.publicationId, schema.workspacePublicationDay.day], set: { pageViews: sql`${schema.workspacePublicationDay.pageViews} + 1` } });
}

/** A visitor's address as a keyed digest: enough to count them apart and limit them, never stored as it was. */
let visitorKey: Buffer | null = null;
export function visitorDigest(ip: string | null): string {
  visitorKey ??= Buffer.from(hkdfSync('sha256', authSecret(), 're0:publish', 're0:publish-visitor:v1', 32));
  return createHmac('sha256', visitorKey).update(ip ?? 'unknown').digest('base64url').slice(0, 32);
}

const plainError = (status: number, text: string, extra: Record<string, string> = {}) =>
  new Response(text, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex', ...extra } });

/**
 * `/f/<id>/raw`: the pinned bytes, always as an attachment, typed from the
 * published extension, never sniffed, sandboxed. Counted and limited before
 * the first byte; the whole size is counted when the download starts.
 */
export async function serveDownload(publicId: string, ip: string | null, now = new Date()): Promise<Response> {
  const loaded = await load(publicId, now);
  if (!loaded) return plainError(404, 'This file is not available.');
  if (loaded.availability === 'daily_limit') return plainError(429, 'This file has reached today’s download limit. Try again tomorrow.', { 'retry-after': '3600' });
  if (loaded.availability !== 'live') return plainError(404, 'This file is not available.');
  const { row } = loaded;
  const allowed = await hitRateBucket(`publishDownload:3600:${row.id}:${visitorDigest(ip)}`, PUBLISH_DOWNLOADS_PER_IP_HOUR, 3600, now);
  if (!allowed) return plainError(429, 'Too many downloads of this file from your address. Try again later.', { 'retry-after': '3600' });
  const counted = await recordOrRefuse(row, now);
  if (!counted) return plainError(429, 'This file has reached today’s download limit. Try again tomorrow.', { 'retry-after': '3600' });
  const pathname = workspaceObjectPath(row.workspaceId, row.sha256);
  if (row.size > WORKSPACE_DOWNLOAD_INLINE_MAX) {
    const url = PUBLISH_BLOB_REDIRECT ? await signedObjectUrl(pathname, 60_000) : null;
    if (!url) return plainError(404, 'This file is not available.');
    return new Response(null, { status: 302, headers: { location: url, 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex' } });
  }
  const object = await openWorkspaceObject(pathname);
  if (!object) return plainError(404, 'This file is not available.');
  const type = row.mediaType.startsWith('text/') || row.mediaType === 'application/json' || row.mediaType.endsWith('+xml') || row.mediaType === 'application/xml' || row.mediaType === 'application/yaml' ? `${row.mediaType}; charset=utf-8` : row.mediaType;
  return new Response(object.stream, {
    headers: {
      'content-type': type,
      'content-length': String(row.size),
      'content-disposition': attachmentDisposition(row.fileName),
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'private, no-store',
      'x-robots-tag': 'noindex',
      'referrer-policy': 'no-referrer',
      'cross-origin-resource-policy': 'same-origin',
    },
  });
}

/** One download: the file's day and the owner's day and month, under the owner's usage lock, checked against the daily ceilings again there. */
async function record(tx: Tx, row: Publication, now: Date): Promise<boolean> {
  const usage = await lockUsage(tx, row.ownerId);
  const today = dayOf(now);
  const month = monthOf(now);
  const dayBytes = (usage.egressDay === today ? usage.egressDayBytes : 0) + row.size;
  if (dayBytes > (await effectiveCeiling('publishDailyMb')) * MB) return false;
  const [file] = await tx
    .insert(schema.workspacePublicationDay)
    .values({ publicationId: row.id, day: today, downloads: 1, bytes: row.size })
    .onConflictDoUpdate({
      target: [schema.workspacePublicationDay.publicationId, schema.workspacePublicationDay.day],
      set: { downloads: sql`${schema.workspacePublicationDay.downloads} + 1`, bytes: sql`${schema.workspacePublicationDay.bytes} + ${row.size}` },
    })
    .returning({ bytes: schema.workspacePublicationDay.bytes });
  if (file!.bytes > (await effectiveCeiling('publishFileDailyMb')) * MB) {
    /* Undone: the transaction rolls back with the refusal. */
    throw new FileDayFull();
  }
  const before = usage.egressMonth === month ? usage.egressMonthBytes : 0;
  const free = (await effectiveCeiling('publishFreeMbMonth')) * MB;
  /* This download's share past the month's free volume: what the storage charge bills. */
  const billable = Math.max(0, before + row.size - free) - Math.max(0, before - free);
  await tx
    .update(schema.workspaceUsage)
    .set({
      egressDay: today,
      egressDayBytes: dayBytes,
      egressMonth: month,
      egressMonthBytes: before + row.size,
      egressUnbilledBytes: usage.egressUnbilledBytes + billable,
    })
    .where(eq(schema.workspaceUsage.userId, row.ownerId));
  return true;
}

class FileDayFull extends Error {}

/** `serveDownload`'s counting, with a file's own daily volume refusing the same way as the account's. */
async function recordOrRefuse(row: Publication, now: Date): Promise<boolean> {
  try {
    return await db().transaction(async (tx) => record(tx, row, now));
  } catch (error) {
    if (error instanceof FileDayFull) return false;
    throw error;
  }
}

/* ------------------------------------------------------------------ reports */

export const REPORT_REASONS = ['malware', 'phishing', 'illegal', 'infringement', 'personal_data', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

/**
 * A visitor reports a public file; no sign-in, one report per address and
 * file, limited per address. Reports from PUBLISH_REPORT_SUSPEND different
 * addresses within PUBLISH_REPORT_WINDOW_MS suspend it until an
 * administrator looks, and tell the owner.
 */
export async function reportPublication(publicId: string, ip: string | null, input: { reason: unknown; note?: unknown }, now = new Date()): Promise<{ suspended: boolean }> {
  const reason = REPORT_REASONS.includes(input.reason as ReportReason) ? (input.reason as ReportReason) : null;
  if (!reason) throw new PublishError(400, 'invalid_reason', 'Pick a reason.');
  const note = typeof input.note === 'string' ? input.note.trim().slice(0, 500) || null : null;
  const reporter = visitorDigest(ip);
  if (!(await hitRateBucket(`publishReport:3600:${reporter}`, PUBLISH_REPORTS_PER_IP_HOUR, 3600, now))) throw new PublishError(429, 'rate_limited', 'Too many reports from your address. Try again later.');
  const loaded = await load(publicId, now);
  if (!loaded) throw new PublishError(404, 'not_found', 'This file is not available.');
  return db().transaction(async (tx) => {
    await tx.insert(schema.workspacePublicationReport).values({ publicationId: loaded.row.id, reporterDigest: reporter, reason, note, createdAt: now }).onConflictDoNothing();
    const since = new Date(now.getTime() - PUBLISH_REPORT_WINDOW_MS);
    const [{ reports } = { reports: 0 }] = await tx
      .select({ reports: sql<number>`count(*)::int` })
      .from(schema.workspacePublicationReport)
      .where(and(eq(schema.workspacePublicationReport.publicationId, loaded.row.id), isNull(schema.workspacePublicationReport.handledAt), gte(schema.workspacePublicationReport.createdAt, since)));
    if (reports < PUBLISH_REPORT_SUSPEND || loaded.row.suspendedAt) return { suspended: Boolean(loaded.row.suspendedAt) };
    const [suspended] = await tx
      .update(schema.workspacePublication)
      .set({ suspendedAt: now })
      .where(and(eq(schema.workspacePublication.id, loaded.row.id), isNull(schema.workspacePublication.suspendedAt), isNull(schema.workspacePublication.revokedAt)))
      .returning({ id: schema.workspacePublication.id });
    if (suspended) await notify(tx, { userId: loaded.row.ownerId, kind: 'publication', params: { action: 'suspended', title: loaded.row.title }, refId: loaded.row.id });
    return { suspended: true };
  });
}

/* ------------------------------------------------------------------ the console */

export const ADMIN_PUBLICATION_VIEWS = ['reported', 'suspended', 'live', 'revoked'] as const;
export type AdminPublicationView = (typeof ADMIN_PUBLICATION_VIEWS)[number];

/** The console's list: reported (open reports), suspended, live, revoked; newest first, 100 at most; `q` matches title, file name, owner or public id. */
export async function adminPublications(view: AdminPublicationView, q = '') {
  const p = schema.workspacePublication;
  const openReports = sql<number>`(select count(*)::int from ${schema.workspacePublicationReport} r where r.publication_id = ${p.id} and r.handled_at is null)`;
  const conditions = [
    view === 'revoked' ? isNotNull(p.revokedAt) : isNull(p.revokedAt),
    view === 'suspended' ? isNotNull(p.suspendedAt) : sql`true`,
    view === 'reported' ? sql`${openReports} > 0` : sql`true`,
  ];
  if (q) {
    const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    conditions.push(sql`(${p.title} ilike ${pattern} or ${p.fileName} ilike ${pattern} or ${p.publicId} = ${q} or ${schema.user.name} ilike ${pattern} or ${schema.user.email} ilike ${pattern})`);
  }
  const rows = await db()
    .select({
      row: p,
      owner: { id: schema.user.id, name: schema.user.name, email: schema.user.email },
      frozen: schema.workspaceUsage.publishFrozenAt,
      reports: openReports,
      reasons: sql<string[]>`coalesce((select array_agg(distinct r.reason) from ${schema.workspacePublicationReport} r where r.publication_id = ${p.id} and r.handled_at is null), '{}')`,
      takedowns: sql<number>`(select count(*)::int from ${p} o where o.owner_id = ${p.ownerId} and o.revoke_reason = 'admin')`,
    })
    .from(p)
    .innerJoin(schema.user, eq(schema.user.id, p.ownerId))
    .leftJoin(schema.workspaceUsage, eq(schema.workspaceUsage.userId, p.ownerId))
    .where(and(...conditions))
    .orderBy(desc(view === 'reported' ? openReports : p.createdAt), desc(p.createdAt))
    .limit(100);
  return rows.map(({ row, owner, frozen, reports, reasons, takedowns }) => ({ ...viewOf(row), sha256: row.sha256, owner, frozen: frozen !== null, reports, reasons, takedowns, revokeReason: row.revokeReason, suspendedAt: row.suspendedAt, revokedAt: row.revokedAt }));
}

/** Takes a file down for good: revoked, its bytes blocklisted for every account, its reports closed; the owner is told. In the management log. */
export async function adminTakeDown(administratorId: string, id: string, note: string | null, now = new Date()): Promise<boolean> {
  return db().transaction(async (tx) => {
    const [row] = await tx
      .update(schema.workspacePublication)
      .set({ revokedAt: now, revokeReason: 'admin', revokedBy: administratorId, updatedAt: now })
      .where(and(eq(schema.workspacePublication.id, id), isNull(schema.workspacePublication.revokedAt)))
      .returning();
    if (!row) return false;
    await tx.insert(schema.publishBlock).values({ sha256: row.sha256, reason: note?.slice(0, 500) || 'takedown', createdBy: administratorId, createdAt: now }).onConflictDoNothing();
    await tx.update(schema.workspacePublicationReport).set({ handledAt: now }).where(and(eq(schema.workspacePublicationReport.publicationId, row.id), isNull(schema.workspacePublicationReport.handledAt)));
    await notify(tx, { userId: row.ownerId, kind: 'publication', text: note?.slice(0, 500) ?? '', params: { action: 'taken_down', title: row.title }, refId: row.id });
    await audit(tx, { administratorId, action: 'workspace.publication.takedown', target: row.id, before: { publicId: row.publicId, ownerId: row.ownerId, sha256: row.sha256, title: row.title, suspendedAt: row.suspendedAt }, after: { note } });
    return true;
  });
}

/** Lifts a suspension the reports caused, and closes those reports; the owner is told. In the management log. */
export async function adminRestore(administratorId: string, id: string, now = new Date()): Promise<boolean> {
  return db().transaction(async (tx) => {
    const [row] = await tx
      .update(schema.workspacePublication)
      .set({ suspendedAt: null })
      .where(and(eq(schema.workspacePublication.id, id), isNull(schema.workspacePublication.revokedAt), isNotNull(schema.workspacePublication.suspendedAt)))
      .returning();
    if (!row) return false;
    await tx.update(schema.workspacePublicationReport).set({ handledAt: now }).where(and(eq(schema.workspacePublicationReport.publicationId, row.id), isNull(schema.workspacePublicationReport.handledAt)));
    await notify(tx, { userId: row.ownerId, kind: 'publication', params: { action: 'restored', title: row.title }, refId: row.id });
    await audit(tx, { administratorId, action: 'workspace.publication.restore', target: row.id, before: { publicId: row.publicId } });
    return true;
  });
}

/** Freezes (or unfreezes) an account's publishing: its links go unavailable and nothing new can be published. In the management log. */
export async function adminFreezePublishing(administratorId: string, userId: string, frozen: boolean, now = new Date()): Promise<boolean> {
  return db().transaction(async (tx) => {
    const usage = await lockUsage(tx, userId);
    if ((usage.publishFrozenAt !== null) === frozen) return false;
    await tx.update(schema.workspaceUsage).set({ publishFrozenAt: frozen ? now : null }).where(eq(schema.workspaceUsage.userId, userId));
    await notify(tx, { userId, kind: 'publication', params: { action: frozen ? 'frozen' : 'unfrozen', title: '' } });
    await audit(tx, { administratorId, action: frozen ? 'workspace.publication.freeze' : 'workspace.publication.unfreeze', target: userId });
    return true;
  });
}

/**
 * For citations (docs/design/agent-workspace-p4.md §2.1): which of these
 * knowledge rows are workspace files with a live, unsuspended public
 * original, and its path `/f/<id>`. One query, whatever the count.
 */
export async function publishedOriginals(knowledgeIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(knowledgeIds)].filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  if (ids.length === 0) return new Map();
  const rows = await db()
    .select({ knowledgeId: schema.knowledge.id, publicId: schema.workspacePublication.publicId })
    .from(schema.knowledge)
    .innerJoin(schema.workspacePublication, and(eq(schema.workspacePublication.entryId, schema.knowledge.workspaceEntryId), isNull(schema.workspacePublication.revokedAt), isNull(schema.workspacePublication.suspendedAt)))
    .innerJoin(schema.workspaceEntry, and(eq(schema.workspaceEntry.id, schema.workspacePublication.entryId), isNull(schema.workspaceEntry.deletedAt)))
    .where(inArray(schema.knowledge.id, ids));
  return new Map(rows.map((row) => [row.knowledgeId, `/f/${row.publicId}`]));
}
