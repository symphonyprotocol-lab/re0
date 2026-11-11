/**
 * A Ree's video introduction against the database (rebuild-proposal.md 2.6,
 * 8.4 step 7): the narrated script of the chosen video type, written by
 * the generation model and voiced (credits held then settled, refunded when
 * it fails), the owner's style edits,
 * and MP4 exports rendered in the owner's browser -- each Ree's first free,
 * then the configured price held at the start and settled after upload;
 * the same picture again is a cache hit, free and not counted. A started
 * export whose tab closed is abandoned and released by the cron.
 */
import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import {
  QUERY_BASE_FEE,
  VIDEO_COMPOSITION_VERSION,
  VIDEO_EXPORT_ABANDON_MINUTES,
  VIDEO_EXPORT_MAX_BYTES,
  type VideoTemplate,
} from '@/lib/constants';
import { demoGenerationLimit, demoSpeechRate, narrationPath, recommendedTemplate, storyTemplate } from '@/lib/domain/product-demo';
import { clampPage, isUuid, likePattern } from '@/lib/domain/list';
import { avatarImageUrl } from '@/lib/domain/ree';
import {
  canonicalJson,
  DEFAULT_STYLE,
  exportCost,
  renderKey,
  type IntroProps,
  type VideoPatch,
} from '@/lib/domain/video';
import { appBaseUrl } from '@/lib/http/cookies';
import { endpointFor, endpointHasCredentials } from '@/lib/infra/ai/models';
import { DemoScriptError, writeNarratedVideo } from '@/lib/services/product-demo';
import { videoExportPrice, videoScriptPrice } from '@/lib/services/video-pricing';
import { blobSize, deleteBlob, uploadTicket, type UploadTicket } from '@/lib/infra/blob';
import { db, schema, type Executor, type Tx } from '@/lib/infra/db';
import { answerable } from '@/lib/services/chat';
import { placeHold, releaseHold, settleHold } from '@/lib/services/credits';

export type VideoRow = typeof schema.reeVideo.$inferSelect;
export type ExportRow = typeof schema.videoExport.$inferSelect;

export class VideoError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = 'VideoError';
  }
}

/** What the editor shows when there is no row yet: nothing generated, the default style in the given type. */
export function emptyVideo(reeId: string, template: VideoTemplate = DEFAULT_STYLE.template): VideoRow {
  const now = new Date(0);
  return {
    reeId,
    generated: false,
    revision: 0,
    template,
    accentColor: DEFAULT_STYLE.accent,
    aspect: DEFAULT_STYLE.aspect,
    music: DEFAULT_STYLE.music,
    scenes: null,
    exportsCount: 0,
    generatedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

export async function videoOf(executor: Executor, reeId: string, lock = false): Promise<VideoRow | null> {
  const query = executor.select().from(schema.reeVideo).where(eq(schema.reeVideo.reeId, reeId));
  const [row] = await (lock ? query.for('update') : query);
  return row ?? null;
}

/** The owner's live Ree, locked when asked; deleted Rees and ids that are not uuids are gone. */
async function ownerRee(executor: Executor, ownerId: string, reeId: string, lock = false) {
  if (!isUuid(reeId)) throw new VideoError('not_found', 404);
  const query = executor
    .select()
    .from(schema.ree)
    .where(and(eq(schema.ree.id, reeId), eq(schema.ree.ownerId, ownerId), isNull(schema.ree.deletedAt)));
  const [row] = await (lock ? query.for('update') : query);
  if (!row) throw new VideoError('not_found', 404);
  return row;
}

async function readySourceCount(executor: Executor, reeId: string): Promise<number> {
  const [row] = await executor
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.knowledge)
    .where(and(eq(schema.knowledge.reeId, reeId), ...answerable()));
  return row?.count ?? 0;
}

/** `readySourceCount` for many Rees in one query. */
async function readySourceCounts(reeIds: readonly string[]): Promise<Map<string, number>> {
  if (reeIds.length === 0) return new Map();
  const rows = await db()
    .select({ reeId: schema.knowledge.reeId, count: sql<number>`count(*)::int` })
    .from(schema.knowledge)
    .where(and(inArray(schema.knowledge.reeId, [...reeIds]), ...answerable()))
    .groupBy(schema.knowledge.reeId);
  return new Map(rows.map((row) => [row.reeId, row.count]));
}

/* -------------------------------------------------------------- props */

type ReeFacts = Pick<typeof schema.ree.$inferSelect, 'slug' | 'avatarBlob' | 'color' | 'queryFee' | 'isPublic' | 'isPublished' | 'moderatedAt'>;

/** The composition's props: the saved script and style, and the Ree's live facts. */
export function introProps(video: VideoRow, ree: ReeFacts, sourcesTotal: number): IntroProps | null {
  if (!video.generated || !video.scenes) return null;
  const visible = ree.isPublic && ree.isPublished && !ree.moderatedAt;
  const story = video.scenes.demo;
  /* A video whose type was switched after generation has no picture until it is generated in that type. */
  if (!story || storyTemplate(story) !== video.template) return null;
  return {
    template: video.template,
    accent: video.accentColor,
    aspect: video.aspect,
    music: video.music,
    scenes: video.scenes,
    narrationUrl: `/media/${narrationPath(video.reeId, story.audioId)}`,
    ree: {
      avatarUrl: avatarImageUrl(ree.avatarBlob),
      color: ree.color,
      price: QUERY_BASE_FEE + ree.queryFee,
      slug: ree.slug,
      shareUrl: visible ? `${appBaseUrl()}/r/${ree.slug}` : null,
      sourcesTotal,
    },
  };
}

/** An export's identity: what the render draws (`renderInputs`), and the drawing's own version. Same hash, same file. */
export function contentVersion(props: IntroProps): string {
  return createHash('sha256').update(`r${VIDEO_COMPOSITION_VERSION}:${renderKey(props)}`).digest('hex');
}

/**
 * The identity exports were stored under before review C4: a hash of all
 * of `IntroProps`. A file stored that way still matches when nothing at all
 * has changed, so existing exports are neither re-charged nor marked stale
 * by the switch.
 */
export function legacyContentVersion(props: IntroProps): string {
  return createHash('sha256').update(`v${VIDEO_COMPOSITION_VERSION}:${canonicalJson(props)}`).digest('hex');
}

/** Every identity a finished export of this picture may carry. */
export function exportVersions(props: IntroProps): string[] {
  return [contentVersion(props), legacyContentVersion(props)];
}

/**
 * The introductions of many Rees at once (public page, explore and My Rees
 * cards, the home page): props for each Ree that has a generated script.
 */
export async function introsFor(reeIds: readonly string[]): Promise<Map<string, IntroProps>> {
  const out = new Map<string, IntroProps>();
  if (reeIds.length === 0) return out;
  const [rows, sources] = await Promise.all([
    db()
      .select({
        video: schema.reeVideo,
        slug: schema.ree.slug,
        avatarBlob: schema.ree.avatarBlob,
        color: schema.ree.color,
        queryFee: schema.ree.queryFee,
        isPublic: schema.ree.isPublic,
        isPublished: schema.ree.isPublished,
        moderatedAt: schema.ree.moderatedAt,
      })
      .from(schema.reeVideo)
      .innerJoin(schema.ree, eq(schema.ree.id, schema.reeVideo.reeId))
      .where(and(inArray(schema.reeVideo.reeId, [...reeIds]), eq(schema.reeVideo.generated, true))),
    readySourceCounts(reeIds),
  ]);
  for (const row of rows) {
    const props = introProps(row.video, row, sources.get(row.video.reeId) ?? 0);
    if (props) out.set(row.video.reeId, props);
  }
  return out;
}

/** The video type the editor suggests for this Ree, from its name, introduction and ready sources. */
async function recommendation(executor: Executor, ree: typeof schema.ree.$inferSelect): Promise<VideoTemplate> {
  const sources = await executor
    .select({ title: schema.knowledge.title, kind: schema.knowledge.kind })
    .from(schema.knowledge)
    .where(and(eq(schema.knowledge.reeId, ree.id), ...answerable()))
    .orderBy(asc(schema.knowledge.createdAt))
    .limit(20);
  return recommendedTemplate({ name: ree.name, description: ree.description, titles: sources.map((source) => source.title), kinds: sources.map((source) => source.kind) });
}

/** The editor's state: the row (or the empty one), the props the Player draws, readiness and the last export. */
export async function videoStudio(ownerId: string, reeId: string) {
  const database = db();
  const ree = await ownerRee(database, ownerId, reeId);
  const [video, ready, last, voice, scriptPrice, exportPrice] = await Promise.all([
    videoOf(database, reeId),
    readySourceCount(database, reeId),
    database
      .select()
      .from(schema.videoExport)
      .where(and(eq(schema.videoExport.reeId, reeId), eq(schema.videoExport.status, 'done')))
      .orderBy(desc(schema.videoExport.finishedAt))
      .limit(1),
    endpointFor('speech'),
    videoScriptPrice(database),
    videoExportPrice(database),
  ]);
  const recommended = await recommendation(database, ree);
  const row = video ?? emptyVideo(reeId, recommended);
  const props = introProps(row, ree, ready);
  const latest = last[0] ?? null;
  const rate = voice.transport === 'gateway' ? demoSpeechRate(voice.model) : 0;
  return {
    ree,
    video: row,
    props,
    readySources: ready,
    recommended,
    scriptCredits: scriptPrice.credits,
    exportCredits: exportPrice.credits,
    demoCredits: rate !== undefined && endpointHasCredentials(voice) ? demoGenerationLimit(rate, scriptPrice.credits) : null,
    lastExport: latest ? { id: latest.id, url: `/media/${latest.blobUrl}`, aspect: latest.aspect, cost: latest.costCredits, finishedAt: latest.finishedAt, current: props ? exportVersions(props).includes(latest.contentVersion) : false } : null,
  };
}

/* -------------------------------------------------------------- script */

interface Material {
  name: string;
  description: string;
  category: string;
  tags: string[];
  titles: string[];
  passages: string[];
}

/** What the script is written from: the Ree's own words, its knowledge titles and the opening passages of its sources. */
async function material(ree: typeof schema.ree.$inferSelect): Promise<Material> {
  const database = db();
  const [sources, passages] = await Promise.all([
    database
      .select({ title: schema.knowledge.title })
      .from(schema.knowledge)
      .where(and(eq(schema.knowledge.reeId, ree.id), ...answerable()))
      .orderBy(asc(schema.knowledge.createdAt))
      .limit(8),
    database
      .select({ content: schema.chunk.content })
      .from(schema.chunk)
      .innerJoin(schema.knowledge, eq(schema.knowledge.id, schema.chunk.knowledgeId))
      .where(and(eq(schema.chunk.reeId, ree.id), ...answerable()))
      .orderBy(asc(schema.chunk.ordinal), asc(schema.chunk.knowledgeId))
      .limit(8),
  ]);
  return {
    name: ree.name,
    description: ree.description,
    category: ree.category,
    tags: ree.tags,
    titles: sources.map((source) => source.title),
    passages: passages.map((passage) => passage.content.slice(0, 600)),
  };
}

/**
 * `POST /api/rees/[id]/video/script`: holds the quoted credits (the script
 * price and the most the voiceover can cost), writes and voices the script
 * in the chosen video type, stores it (a new revision; accent and music are
 * kept) and settles the actual cost; any failure releases the hold. Needs a
 * ready source (8.4 acceptance) and a configured voice model.
 */
export async function generateScript(
  ownerId: string,
  reeId: string,
  options: { template?: VideoTemplate; revision?: number; maxCost?: number } = {},
) {
  const database = db();
  const { ree, holdId, current, template, voice, speechRate, scriptCredits } = await database.transaction(async (tx) => {
    const ree = await ownerRee(tx, ownerId, reeId, true);
    const current = (await videoOf(tx, reeId, true)) ?? emptyVideo(reeId);
    if (options.revision !== undefined && current.revision !== options.revision) throw new VideoError('stale', 409);
    if ((await readySourceCount(tx, reeId)) === 0) throw new VideoError('no_ready_source', 409);
    const template = options.template ?? current.template;
    const voice = await endpointFor('speech');
    const speechRate = voice.transport === 'gateway' ? demoSpeechRate(voice.model) : 0;
    if (speechRate === undefined || !endpointHasCredentials(voice)) throw new VideoError('voice_not_configured', 409);
    const { credits: scriptCredits } = await videoScriptPrice(tx);
    const amount = demoGenerationLimit(speechRate, scriptCredits);
    if (options.maxCost !== undefined && amount > options.maxCost) throw new VideoError('price_changed', 409);
    const [running] = await tx
      .select({ id: schema.creditHold.id })
      .from(schema.creditHold)
      .where(and(eq(schema.creditHold.refId, reeId), eq(schema.creditHold.kind, 'video'), eq(schema.creditHold.status, 'held')))
      .limit(1);
    if (running) throw new VideoError('script_running', 409);
    const holdId = await placeHold(tx, { userId: ownerId, kind: 'video', ledger: 'video_script', amount, refId: reeId, reeId, note: ree.name });
    return { ree, holdId, current, template, voice, speechRate, scriptCredits };
  });
  let audioId: string | undefined;
  try {
    const written = await writeNarratedVideo(template, await material(ree), reeId, ownerId, voice, speechRate, current.scenes);
    audioId = written.scenes.demo?.audioId;
    const row = await database.transaction(async (tx) => {
      await ownerRee(tx, ownerId, reeId, true);
      if (((await videoOf(tx, reeId, true))?.revision ?? 0) !== current.revision) throw new VideoError('stale', 409);
      const now = new Date();
      const music = current.scenes?.demo ? current.music : true;
      const values = { template, aspect: '16:9' as const, music, generated: true, scenes: written.scenes, generatedAt: now, updatedAt: now };
      const [row] = await tx
        .insert(schema.reeVideo)
        .values({ ...values, reeId, revision: 1 })
        .onConflictDoUpdate({ target: schema.reeVideo.reeId, set: { ...values, revision: sql`${schema.reeVideo.revision} + 1` } })
        .returning();
      const settlement = await settleHold(tx, holdId, scriptCredits + written.voiceCredits, { reeId, note: ree.name, ledger: 'video_script' });
      if (!settlement) throw new VideoError('script_failed', 409);
      return { ...row!, generationCost: settlement.charged };
    });
    if (current.scenes?.demo) await deleteBlob(narrationPath(reeId, current.scenes.demo.audioId)).catch(() => undefined);
    return row;
  } catch (error) {
    console.warn(`video script ree=${reeId} failed: ${error instanceof Error ? error.message : 'unknown'}`);
    if (audioId && error instanceof VideoError) await deleteBlob(narrationPath(reeId, audioId)).catch(() => undefined);
    await database.transaction((tx) => releaseHold(tx, holdId, { reeId, note: ree.name, ledger: 'video_script' }));
    if (error instanceof VideoError) throw error;
    throw new VideoError(error instanceof DemoScriptError ? 'demo_script_unfit' : 'script_failed', 502);
  }
}

/* -------------------------------------------------------------- edits */

/**
 * `PATCH /api/rees/[id]/video`: the style any time. Once a script exists,
 * the type stays the one it was written in (another type needs a new
 * script). The editor sends the revision it loaded; another save since then
 * is a 409, so a second tab cannot silently overwrite the first.
 */
export async function saveVideo(ownerId: string, reeId: string, patch: VideoPatch, revision: number): Promise<VideoRow> {
  return db().transaction(async (tx) => {
    await ownerRee(tx, ownerId, reeId, true);
    const current = (await videoOf(tx, reeId, true)) ?? emptyVideo(reeId);
    if (current.revision !== revision) throw new VideoError('stale', 409, { revision: current.revision });
    const template = patch.template ?? current.template;
    const story = current.scenes?.demo;
    if (current.generated && (!story || storyTemplate(story) !== template)) throw new VideoError('no_script', 409);
    const values = {
      template,
      accentColor: patch.accent ?? current.accentColor,
      aspect: '16:9' as const,
      music: patch.music ?? current.music,
      updatedAt: new Date(),
    };
    const [row] = await tx
      .insert(schema.reeVideo)
      .values({ reeId, ...values, revision: 1 })
      .onConflictDoUpdate({ target: schema.reeVideo.reeId, set: { ...values, revision: sql`${schema.reeVideo.revision} + 1` } })
      .returning();
    return row!;
  });
}

/* -------------------------------------------------------------- exports */

export type ExportStart =
  | { cached: true; url: string; aspect: string }
  | { cached: false; exportId: string; cost: number; props: IntroProps; upload: UploadTicket };

/**
 * What exporting now would do, before anything is held: the cached file when
 * the saved picture was exported before, else the price (free for the
 * Ree's first). The confirmation shows this.
 */
export async function exportQuote(ownerId: string, reeId: string): Promise<{ cached: string | null; cost: number }> {
  const database = db();
  const ree = await ownerRee(database, ownerId, reeId);
  const video = await videoOf(database, reeId);
  const props = video ? introProps(video, ree, await readySourceCount(database, reeId)) : null;
  if (!video || !props) throw new VideoError('no_script', 409);
  const [done] = await database
    .select({ blobUrl: schema.videoExport.blobUrl })
    .from(schema.videoExport)
    .where(and(eq(schema.videoExport.reeId, reeId), inArray(schema.videoExport.contentVersion, exportVersions(props)), eq(schema.videoExport.status, 'done')))
    .limit(1);
  if (done) return { cached: `/media/${done.blobUrl}`, cost: 0 };
  return { cached: null, cost: exportCost(video.exportsCount, (await videoExportPrice(database)).credits) };
}

/** Gives back a started export's hold and marks it abandoned; its upload, if any arrived, is deleted. */
async function abandon(tx: Tx, row: ExportRow, now: Date): Promise<void> {
  await tx.update(schema.videoExport).set({ status: 'abandoned', finishedAt: now }).where(eq(schema.videoExport.id, row.id));
  const [hold] = await tx
    .select({ id: schema.creditHold.id })
    .from(schema.creditHold)
    .where(and(eq(schema.creditHold.refId, row.id), eq(schema.creditHold.kind, 'video'), eq(schema.creditHold.status, 'held')))
    .limit(1);
  if (hold) await releaseHold(tx, hold.id, { reeId: row.reeId, note: 'export abandoned', ledger: 'video_export' }, now);
}

export function exportPathname(reeId: string, exportId: string): string {
  return `videos/${reeId}/${exportId}.mp4`;
}

/**
 * `POST /api/rees/[id]/video/exports`: the export starts from what is saved.
 * Same picture as a finished export → that file, free, not counted. Else a
 * `started` row (any earlier unfinished one is abandoned first, so a reload
 * never leaves two holds), the current price held unless it is the Ree's first, and
 * an upload token for exactly this export's pathname.
 */
export async function startExport(ownerId: string, reeId: string, now = new Date(), maxCost?: number): Promise<ExportStart> {
  const { start, staleUploads } = await db().transaction(async (tx) => {
    const ree = await ownerRee(tx, ownerId, reeId, true);
    const video = await videoOf(tx, reeId, true);
    const props = video ? introProps(video, ree, await readySourceCount(tx, reeId)) : null;
    if (!video || !props) throw new VideoError('no_script', 409);
    const version = contentVersion(props);
    const [done] = await tx
      .select()
      .from(schema.videoExport)
      .where(and(eq(schema.videoExport.reeId, reeId), inArray(schema.videoExport.contentVersion, exportVersions(props)), eq(schema.videoExport.status, 'done')))
      .limit(1);
    if (done) return { start: { cached: true as const, url: `/media/${done.blobUrl}`, aspect: done.aspect }, staleUploads: [] };
    const cost = exportCost(video.exportsCount, (await videoExportPrice(tx)).credits);
    if (maxCost !== undefined && cost > maxCost) throw new VideoError('price_changed', 409);
    const open = await tx
      .select()
      .from(schema.videoExport)
      .where(and(eq(schema.videoExport.reeId, reeId), eq(schema.videoExport.status, 'started')))
      .for('update');
    for (const row of open) await abandon(tx, row, now);
    const exportId = randomUUID();
    await tx.insert(schema.videoExport).values({ id: exportId, reeId, userId: ownerId, contentVersion: version, template: video.template, aspect: video.aspect, costCredits: cost, createdAt: now });
    if (cost > 0) await placeHold(tx, { userId: ownerId, kind: 'video', ledger: 'video_export', amount: cost, refId: exportId, reeId, note: ree.name }, now);
    return { start: { cached: false as const, exportId, cost, props }, staleUploads: open.map((row) => exportPathname(reeId, row.id)) };
  });
  await removeUploads(staleUploads);
  if (start.cached) return start;
  const upload = await uploadTicket(exportPathname(reeId, start.exportId), { contentTypes: ['video/mp4'], maxBytes: VIDEO_EXPORT_MAX_BYTES, ttlSeconds: VIDEO_EXPORT_ABANDON_MINUTES * 60 });
  return { ...start, upload };
}

async function removeUploads(pathnames: readonly string[]): Promise<void> {
  for (const pathname of pathnames) {
    try {
      if ((await blobSize(pathname)) !== null) await deleteBlob(pathname);
    } catch (error) {
      console.warn(`video upload cleanup ${pathname} failed: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }
}

/**
 * `POST …/exports/[exportId]/complete`: the browser rendered and uploaded the
 * file. It must be there; then the export is done, counted, and its hold
 * settled. A finished, cancelled or abandoned export cannot complete.
 */
export async function completeExport(ownerId: string, reeId: string, exportId: string, now = new Date()): Promise<{ url: string; cost: number }> {
  if (!isUuid(exportId)) throw new VideoError('not_found', 404);
  await ownerRee(db(), ownerId, reeId);
  const pathname = exportPathname(reeId, exportId);
  const bytes = await blobSize(pathname);
  if (!bytes) throw new VideoError('upload_missing', 409);
  const finished = db().transaction(async (tx) => {
    const ree = await ownerRee(tx, ownerId, reeId);
    const [row] = await tx
      .select()
      .from(schema.videoExport)
      .where(and(eq(schema.videoExport.id, exportId), eq(schema.videoExport.reeId, reeId)))
      .for('update');
    if (!row) throw new VideoError('not_found', 404);
    if (row.status === 'done') return { url: `/media/${row.blobUrl}`, cost: row.costCredits };
    if (row.status !== 'started') throw new VideoError('export_closed', 409);
    await tx.update(schema.videoExport).set({ status: 'done', blobUrl: pathname, bytes, finishedAt: now }).where(eq(schema.videoExport.id, exportId));
    await tx
      .update(schema.reeVideo)
      .set({ exportsCount: sql`${schema.reeVideo.exportsCount} + 1` })
      .where(eq(schema.reeVideo.reeId, reeId));
    const [hold] = await tx
      .select({ id: schema.creditHold.id })
      .from(schema.creditHold)
      .where(and(eq(schema.creditHold.refId, exportId), eq(schema.creditHold.kind, 'video'), eq(schema.creditHold.status, 'held')))
      .limit(1);
    if (hold) await settleHold(tx, hold.id, row.costCredits, { reeId, note: ree.name, ledger: 'video_export' }, now);
    return { url: `/media/${pathname}`, cost: row.costCredits };
  });
  /* An upload that arrived after a cancel or the cron is never served; it is removed here too. */
  return finished.catch(async (error) => {
    if (error instanceof VideoError && error.code === 'export_closed') await removeUploads([pathname]);
    throw error;
  });
}

/** "取消" while rendering or uploading: the export is abandoned and its hold released at once. */
export async function cancelExport(ownerId: string, reeId: string, exportId: string, now = new Date()): Promise<boolean> {
  if (!isUuid(exportId)) throw new VideoError('not_found', 404);
  const cancelled = await db().transaction(async (tx) => {
    await ownerRee(tx, ownerId, reeId);
    const [row] = await tx
      .select()
      .from(schema.videoExport)
      .where(and(eq(schema.videoExport.id, exportId), eq(schema.videoExport.reeId, reeId), eq(schema.videoExport.status, 'started')))
      .for('update');
    if (!row) return false;
    await abandon(tx, row, now);
    return true;
  });
  if (cancelled) await removeUploads([exportPathname(reeId, exportId)]);
  return cancelled;
}

/** `/media/videos/…` serves only finished exports: a file uploaded after its export was cancelled or abandoned stays private. */
export async function exportFinished(reeId: string, exportId: string): Promise<boolean> {
  const [row] = await db()
    .select({ id: schema.videoExport.id })
    .from(schema.videoExport)
    .where(and(eq(schema.videoExport.id, exportId), eq(schema.videoExport.reeId, reeId), eq(schema.videoExport.status, 'done')))
    .limit(1);
  return Boolean(row);
}

/** A finished introduction is visible only to its owner or while its Ree is published. */
export async function exportVisibleTo(reeId: string, exportId: string, viewerId: string | null): Promise<boolean> {
  const [row] = await db().select({ id: schema.videoExport.id }).from(schema.videoExport)
    .innerJoin(schema.ree, eq(schema.ree.id, schema.videoExport.reeId))
    .where(and(
      eq(schema.videoExport.id, exportId), eq(schema.videoExport.reeId, reeId), eq(schema.videoExport.status, 'done'),
      isNull(schema.ree.deletedAt),
      or(viewerId ? eq(schema.ree.ownerId, viewerId) : undefined,
        and(eq(schema.ree.isPublic, true), eq(schema.ree.isPublished, true), isNull(schema.ree.moderatedAt))),
    )).limit(1);
  return Boolean(row);
}

export async function narrationVisibleTo(reeId: string, audioId: string, viewerId: string | null): Promise<boolean> {
  const [row] = await db().select({ template: schema.reeVideo.template, scenes: schema.reeVideo.scenes, ownerId: schema.ree.ownerId })
    .from(schema.reeVideo)
    .innerJoin(schema.ree, eq(schema.ree.id, schema.reeVideo.reeId))
    .where(and(eq(schema.reeVideo.reeId, reeId), isNull(schema.ree.deletedAt),
      or(viewerId ? eq(schema.ree.ownerId, viewerId) : undefined,
        and(eq(schema.ree.isPublic, true), eq(schema.ree.isPublished, true), isNull(schema.ree.moderatedAt)))))
    .limit(1);
  const story = row?.scenes?.demo;
  return story?.audioId === audioId && (row!.ownerId === viewerId || storyTemplate(story) === row!.template);
}

/**
 * `/api/cron/abandon-exports`: exports started more than 30 minutes ago and
 * never completed (the tab was closed) are abandoned and their holds
 * released; so is a script hold left by a request that died mid-generation.
 * Locked rows are skipped for the next run. Idempotent.
 */
export async function abandonExports(now = new Date()): Promise<{ exports: number; scripts: number }> {
  const cutoff = new Date(now.getTime() - VIDEO_EXPORT_ABANDON_MINUTES * 60_000);
  const database = db();
  const { rows, scripts } = await database.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(schema.videoExport)
      .where(and(eq(schema.videoExport.status, 'started'), lt(schema.videoExport.createdAt, cutoff)))
      .limit(200)
      .for('update', { skipLocked: true });
    for (const row of rows) await abandon(tx, row, now);
    const stale = await tx
      .select({ id: schema.creditHold.id, refId: schema.creditHold.refId })
      .from(schema.creditHold)
      .where(
        and(
          eq(schema.creditHold.kind, 'video'),
          eq(schema.creditHold.status, 'held'),
          lt(schema.creditHold.createdAt, cutoff),
          sql`not exists (select 1 from ${schema.videoExport} e where e.id = ${schema.creditHold.refId})`,
        ),
      )
      .limit(200)
      .for('update', { skipLocked: true });
    for (const hold of stale) await releaseHold(tx, hold.id, { reeId: hold.refId, note: 'script interrupted', ledger: 'video_script' }, now);
    return { rows, scripts: stale.length };
  });
  await removeUploads(rows.map((row) => exportPathname(row.reeId, row.id)));
  return { exports: rows.length, scripts };
}

/* -------------------------------------------------------------- /videos */

export interface VideoListItem {
  reeId: string;
  name: string;
  slug: string;
  avatarBlob: string | null;
  color: string;
  isPublic: boolean;
  generated: boolean;
  template: VideoRow['template'];
  accent: string;
  aspect: VideoRow['aspect'];
  exportsCount: number;
  updatedAt: Date | null;
  props: IntroProps | null;
}

/** `/videos`: every live Ree of the owner with its introduction's state, newest video first, paged on the server. */
export async function listVideos(ownerId: string, query: { q: string; page: number; size: number }): Promise<{ items: VideoListItem[]; total: number; page: number; size: number }> {
  const database = db();
  const conditions = [eq(schema.ree.ownerId, ownerId), isNull(schema.ree.deletedAt)];
  if (query.q) conditions.push(sql`${schema.ree.name} ilike ${likePattern(query.q)}`);
  const where = and(...conditions);
  const [{ total }] = (await database.select({ total: sql<number>`count(*)::int` }).from(schema.ree).where(where)) as [{ total: number }];
  const page = clampPage(query.page, total, query.size);
  const rows = await database
    .select({ ree: schema.ree, video: schema.reeVideo })
    .from(schema.ree)
    .leftJoin(schema.reeVideo, eq(schema.reeVideo.reeId, schema.ree.id))
    .where(where)
    .orderBy(sql`${schema.reeVideo.generated} is true desc`, desc(sql`coalesce(${schema.reeVideo.updatedAt}, ${schema.ree.createdAt})`), desc(schema.ree.createdAt))
    .limit(query.size)
    .offset((page - 1) * query.size);
  const sources = await readySourceCounts(rows.map((row) => row.ree.id));
  return {
    total,
    page,
    size: query.size,
    items: rows.map(({ ree, video }) => {
      const row = video ?? emptyVideo(ree.id);
      return {
        reeId: ree.id,
        name: ree.name,
        slug: ree.slug,
        avatarBlob: ree.avatarBlob,
        color: ree.color,
        isPublic: ree.isPublic && ree.isPublished && !ree.moderatedAt,
        generated: row.generated,
        template: row.template,
        accent: row.accentColor,
        aspect: row.aspect,
        exportsCount: row.exportsCount,
        updatedAt: video?.updatedAt ?? null,
        props: video ? introProps(video, ree, sources.get(ree.id) ?? 0) : null,
      };
    }),
  };
}
