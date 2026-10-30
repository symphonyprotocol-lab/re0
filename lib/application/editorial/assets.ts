/**
 * Articles and audio episodes: create, draft, publish. agent-first-proposal.md
 * 6.5, 6.6; architecture.md 8.3.
 *
 * Each is an asset with its own version line. Its working copy is the
 * `post_draft` row -- an article's title, summary and Markdown body, an
 * episode's title and show notes -- which is not part of the version line.
 * Publishing copies the draft into the asset's own source (`editor` for an
 * article, `audio` for an episode) as the one document the build indexes,
 * and queues a build: every publication, and every edit of a published
 * post, is a new version through the normal build-and-publish path, built,
 * anchored and metered like any other (requirement.md 4.2.1). A build whose
 * document did not change writes no version.
 *
 * What is indexed: an article's title, summary and body with each image
 * replaced by its caption; an episode's title and show notes, never the
 * audio (no transcription). The episode's file hash is part of the document's
 * path, so replacing the file alone is a new version whose digest covers it.
 *
 * A draft may name a channel and an access level; publishing moves the asset
 * there through `moveAsset` (with its rights and claim gates) and then sets
 * `access` (`setAssetAccess`, which needs subscriptions on for `paid`). A
 * scheduled publication waits on `publish_at` for the queue drain.
 */
import { and, desc, eq, inArray, isNotNull, isNull, lte } from 'drizzle-orm';
import { AppError } from '@/contracts/errors';
import {
  EDITORIAL_LIMITS,
  editorialPublicId,
  EditorialRefused,
  editorialSlugFromTitle,
  episodeDocument,
  normalizeEditorialSlug,
  postDocument,
  publishInstant,
  referencedMedia,
  type EditorialKind,
} from '@/lib/domain/editorial';
import { isAssetAccess, type AssetAccess } from '@/lib/domain/asset-kind';
import { sha256Hex } from '@/lib/domain/ingestion';
import { uuidv7 } from '@/lib/domain/id';
import { parseRightsDeclaration, rightsPosted, type RightsDeclaration } from '@/lib/domain/rights';
import { db, schema, type Database } from '@/lib/infrastructure/postgres/client';
import { moveAsset } from '@/lib/application/channels/manage';
import { setAssetAccess } from '@/lib/application/channels/subscriptions';
import { canManageAssets, type WorkspaceRole } from '@/lib/application/assets/delete';
import { queueBuildUnlessPending } from '@/lib/application/assets/queue-build';
import { assertBuildAffordable } from '@/lib/application/plans/build-quota';
import type { Tx } from '@/lib/application/plans/quota';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Executor = Tx | Database;

export interface EditorActor {
  workspaceId: string;
  role: WorkspaceRole;
  userId: string | null;
}

function assertEditor(role: WorkspaceRole): void {
  if (!canManageAssets(role)) throw new EditorialRefused('not_owner', 'only a workspace owner or admin can publish');
}

/* ------------------------------------------------------------------ create */

export interface CreateEditorialInput extends EditorActor {
  kind: Extract<EditorialKind, 'post' | 'audio'>;
  title: string;
  /** Suggested from the title when blank. */
  slug?: string;
  rights?: { origin?: unknown; license?: unknown; generation?: unknown; note?: unknown };
}

/**
 * A new article or episode: the asset row in `draft`, its source with
 * nothing published yet, and an empty draft. In no channel, its owner's
 * alone, like every new asset (proposal 3.3). The ID needs the workspace's
 * public handle: `/posts/{handle}/{slug}`, `/audio/{handle}/{slug}`.
 */
export async function createEditorialAsset(input: CreateEditorialInput): Promise<{ assetId: string; publicId: string }> {
  assertEditor(input.role);
  const title = input.title.trim();
  if (title.length === 0 || title.length > EDITORIAL_LIMITS.titleMax) {
    throw new EditorialRefused('invalid_title', `a title is 1 to ${EDITORIAL_LIMITS.titleMax} characters`);
  }
  const slug = normalizeEditorialSlug(input.slug?.trim() || editorialSlugFromTitle(title) || `${input.kind}-${uuidv7().slice(-8)}`);
  if (!slug) throw new EditorialRefused('invalid_slug', 'a slug is lowercase letters, digits and dashes');

  let rightsDeclaration: RightsDeclaration | null = null;
  if (input.rights && rightsPosted(input.rights)) {
    rightsDeclaration = parseRightsDeclaration(input.rights, { userId: input.userId, now: new Date() });
    if (!rightsDeclaration) throw new AppError('invalid_request', 'the rights declaration is incomplete');
  }

  const database = db();
  const [workspace] = await database
    .select({ handle: schema.workspace.handle })
    .from(schema.workspace)
    .where(eq(schema.workspace.id, input.workspaceId));
  if (!workspace?.handle) throw new EditorialRefused('no_handle', 'set a public handle for this workspace first');
  const publicId = editorialPublicId(input.kind, workspace.handle, slug);

  const assetId = uuidv7();
  try {
    await database.transaction(async (tx) => {
      await tx.insert(schema.asset).values({
        id: assetId,
        publicId,
        title,
        ownerWorkspaceId: input.workspaceId,
        isPlatformAsset: false,
        kind: input.kind,
        lifecycleStatus: 'draft',
        indexStatus: 'pending',
        rightsDeclaration,
      });
      await tx.insert(schema.source).values({
        id: uuidv7(),
        assetId: assetId,
        type: input.kind === 'post' ? 'editor' : 'audio',
        location: publicId,
        config: {},
      });
      await tx.insert(schema.postDraft).values({ assetId, title, updatedBy: input.userId });
    });
  } catch (error) {
    const messages = [error instanceof Error ? error.message : '', error instanceof Error && error.cause instanceof Error ? error.cause.message : ''].join(' ');
    if (messages.includes('asset_public_id_uq')) throw new EditorialRefused('slug_taken', 'that address is already taken');
    throw error;
  }
  return { assetId, publicId };
}

/* ------------------------------------------------------------------- draft */

export interface EditorialAsset {
  id: string;
  publicId: string;
  kind: EditorialKind;
  title: string;
  description: string | null;
  access: AssetAccess;
  lifecycleStatus: string;
  indexStatus: string;
  currentVersionId: string | null;
  channelId: string | null;
}

/** One of the workspace's own articles or episodes; `not_found` for anything else. */
export async function ownedEditorialAsset(
  executor: Executor,
  workspaceId: string,
  assetId: string,
  kinds: readonly EditorialKind[] = ['post', 'audio'],
): Promise<EditorialAsset> {
  if (!UUID.test(assetId)) throw new EditorialRefused('not_found', 'no such asset');
  const [row] = await executor
    .select({
      id: schema.asset.id,
      publicId: schema.asset.publicId,
      kind: schema.asset.kind,
      title: schema.asset.title,
      description: schema.asset.description,
      access: schema.asset.access,
      lifecycleStatus: schema.asset.lifecycleStatus,
      indexStatus: schema.asset.indexStatus,
      currentVersionId: schema.asset.currentVersionId,
      channelId: schema.channelAsset.channelId,
    })
    .from(schema.asset)
    .leftJoin(schema.channelAsset, eq(schema.channelAsset.assetId, schema.asset.id))
    .where(and(eq(schema.asset.id, assetId), eq(schema.asset.ownerWorkspaceId, workspaceId), isNull(schema.asset.deletedAt)));
  if (!row || !(kinds as readonly string[]).includes(row.kind)) throw new EditorialRefused('not_found', 'no such asset');
  return { ...row, kind: row.kind as EditorialKind };
}

export interface EditorialDraft {
  asset: EditorialAsset;
  title: string;
  summary: string | null;
  body: string;
  publishAt: Date | null;
  channelId: string | null;
  access: AssetAccess;
  updatedAt: Date;
  /** The episode's current file, when it has one. */
  audio: { id: string; bytes: number; mime: string; sha256: string | null } | null;
  /** The article's uploaded images, newest first. */
  images: { id: string; caption: string | null; bytes: number }[];
}

export async function readEditorialDraft(workspaceId: string, assetId: string): Promise<EditorialDraft> {
  const database = db();
  const asset = await ownedEditorialAsset(database, workspaceId, assetId);
  const [[draft], media] = await Promise.all([
    database.select().from(schema.postDraft).where(eq(schema.postDraft.assetId, asset.id)),
    database
      .select({
        id: schema.assetMedia.id,
        kind: schema.assetMedia.kind,
        bytes: schema.assetMedia.bytes,
        mime: schema.assetMedia.mime,
        sha256: schema.assetMedia.sha256,
        caption: schema.assetMedia.caption,
        createdAt: schema.assetMedia.createdAt,
      })
      .from(schema.assetMedia)
      .where(and(eq(schema.assetMedia.assetId, asset.id), eq(schema.assetMedia.state, 'ready'))),
  ]);
  const audio = media.filter((row) => row.kind === 'audio').sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  return {
    asset,
    title: draft?.title ?? asset.title,
    summary: draft?.summary ?? asset.description,
    body: draft?.body ?? '',
    publishAt: draft?.publishAt ?? null,
    channelId: draft?.channelId ?? asset.channelId,
    access: draft?.access ?? asset.access,
    updatedAt: draft?.updatedAt ?? new Date(0),
    audio: audio ? { id: audio.id, bytes: audio.bytes, mime: audio.mime, sha256: audio.sha256 } : null,
    images: media
      .filter((row) => row.kind === 'image')
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((row) => ({ id: row.id, caption: row.caption, bytes: row.bytes })),
  };
}

export interface SaveDraftInput extends EditorActor {
  assetId: string;
  title: string;
  summary?: string | null;
  body: string;
  /** The channel publishing puts it in; empty keeps it where it is. */
  channelId?: string | null;
  access?: unknown;
}

/** Saves the working copy. Nothing is published, indexed or anchored by this. */
export async function saveEditorialDraft(input: SaveDraftInput): Promise<void> {
  assertEditor(input.role);
  const title = input.title.trim();
  if (title.length === 0 || title.length > EDITORIAL_LIMITS.titleMax) {
    throw new EditorialRefused('invalid_title', `a title is 1 to ${EDITORIAL_LIMITS.titleMax} characters`);
  }
  const summary = input.summary?.trim() || null;
  if (summary && summary.length > EDITORIAL_LIMITS.summaryMax) throw new EditorialRefused('invalid_body', 'the summary is too long');
  const database = db();
  const asset = await ownedEditorialAsset(database, input.workspaceId, input.assetId);
  const bodyMax = asset.kind === 'audio' ? EDITORIAL_LIMITS.notesMax : EDITORIAL_LIMITS.bodyMax;
  if (input.body.length > bodyMax) throw new EditorialRefused('invalid_body', `the text is longer than ${bodyMax} characters`);
  const channelId = input.channelId && UUID.test(input.channelId) ? input.channelId : null;
  if (channelId) {
    const [channel] = await database
      .select({ id: schema.channel.id })
      .from(schema.channel)
      .where(and(eq(schema.channel.id, channelId), eq(schema.channel.workspaceId, input.workspaceId)));
    if (!channel) throw new EditorialRefused('not_found', 'no such channel');
  }
  const access = isAssetAccess(input.access) ? input.access : 'free';
  const values = {
    title,
    summary,
    body: input.body,
    channelId,
    access,
    updatedBy: input.userId,
    updatedAt: new Date(),
  };
  await database
    .insert(schema.postDraft)
    .values({ assetId: asset.id, ...values })
    .onConflictDoUpdate({ target: schema.postDraft.assetId, set: values });
}

/* ----------------------------------------------------------------- publish */

export interface PublishResult {
  /** Set when the publication was scheduled rather than done. */
  scheduledFor: Date | null;
  /** The queued build, to run after the response; null when scheduled. */
  operationId: string | null;
}

/**
 * Publishes the draft now, or schedules it. `publishAt` empty, in the past or
 * within a minute is "now".
 */
export async function publishEditorial(
  input: EditorActor & { assetId: string; publishAt?: string | null; schedule?: boolean },
): Promise<PublishResult> {
  assertEditor(input.role);
  const now = new Date();
  const at = publishInstant(input.publishAt, now);
  /* "Schedule" without a future time is a mistake, not a request to publish now. */
  if (input.schedule && !at) throw new EditorialRefused('invalid_schedule', 'choose a time in the future to schedule');
  const database = db();
  const asset = await ownedEditorialAsset(database, input.workspaceId, input.assetId);
  if (at) {
    await database.update(schema.postDraft).set({ publishAt: at, updatedAt: now }).where(eq(schema.postDraft.assetId, asset.id));
    return { scheduledFor: at, operationId: null };
  }
  return { scheduledFor: null, operationId: await publishNow(asset, input) };
}

/** Takes a scheduled publication back to a plain draft. */
export async function unscheduleEditorial(input: EditorActor & { assetId: string }): Promise<void> {
  assertEditor(input.role);
  const asset = await ownedEditorialAsset(db(), input.workspaceId, input.assetId);
  await db().update(schema.postDraft).set({ publishAt: null }).where(eq(schema.postDraft.assetId, asset.id));
}

/**
 * The publication itself: compose the indexed document from the draft,
 * write it to the source, queue the build, then put the asset where the
 * draft says. Returns the build to run.
 */
async function publishNow(asset: EditorialAsset, actor: EditorActor): Promise<string> {
  const database = db();
  const [draft] = await database.select().from(schema.postDraft).where(eq(schema.postDraft.assetId, asset.id));
  if (!draft) throw new EditorialRefused('invalid_body', 'nothing to publish');
  const title = draft.title.trim();
  if (draft.body.trim().length === 0) throw new EditorialRefused('invalid_body', 'write something before publishing');

  let markdown: string;
  let path: string;
  let audioMediaId: string | null = null;
  if (asset.kind === 'audio') {
    const [audio] = await database
      .select({ id: schema.assetMedia.id, sha256: schema.assetMedia.sha256 })
      .from(schema.assetMedia)
      .where(and(eq(schema.assetMedia.assetId, asset.id), eq(schema.assetMedia.kind, 'audio'), eq(schema.assetMedia.state, 'ready')))
      .limit(1);
    if (!audio?.sha256) throw new EditorialRefused('no_audio', 'upload the episode file before publishing');
    audioMediaId = audio.id;
    markdown = episodeDocument({ title, notes: draft.body });
    /* The file's hash is in the path, so the version digest covers the audio (proposal 6.6). */
    path = `episode-${audio.sha256}.md`;
  } else {
    const ids = referencedMedia(draft.body);
    if (ids.length > EDITORIAL_LIMITS.imagesPerPost) throw new EditorialRefused('too_many_images', 'too many images in one post');
    const images = ids.length
      ? await database
          .select({ id: schema.assetMedia.id, caption: schema.assetMedia.caption, sha256: schema.assetMedia.sha256 })
          .from(schema.assetMedia)
          .where(
            and(
              eq(schema.assetMedia.assetId, asset.id),
              eq(schema.assetMedia.kind, 'image'),
              eq(schema.assetMedia.state, 'ready'),
              inArray(schema.assetMedia.id, ids),
            ),
          )
      : [];
    if (images.length !== ids.length) throw new EditorialRefused('not_uploaded', 'the post refers to an image that is not uploaded');
    markdown = postDocument({
      title,
      summary: draft.summary,
      body: draft.body,
      captions: new Map(images.map((image) => [image.id, image.caption])),
    });
    /* An image swapped under the same caption is a changed post; the path says so. */
    path = images.length ? `post-${(await sha256Hex(images.map((image) => image.sha256 ?? image.id).sort().join(','))).slice(0, 16)}.md` : 'post.md';
  }

  /* asset-build-billing.md 4.1: refused before anything is written, like a new asset's first build. */
  await assertBuildAffordable({ workspaceId: actor.workspaceId, fetchesPages: false });

  const operationId = await database.transaction(async (tx) => {
    await tx
      .update(schema.asset)
      .set({ title, description: draft.summary })
      .where(eq(schema.asset.id, asset.id));
    await tx
      .update(schema.source)
      /* The indexed document, and beside it the published text as written -- what the reading page shows. */
      .set({ config: { path, url: `/assets${asset.publicId}`, markdown, summary: draft.summary, body: draft.body, audioMediaId } })
      .where(eq(schema.source.assetId, asset.id));
    await tx.update(schema.postDraft).set({ publishAt: null }).where(eq(schema.postDraft.assetId, asset.id));
    return queueBuildUnlessPending(tx, asset.id);
  });

  const moved = draft.channelId !== null && draft.channelId !== asset.channelId;
  if (moved) {
    await moveAsset({ workspaceId: actor.workspaceId, role: actor.role, assetId: asset.id, channelId: draft.channelId });
  }
  /* A move resets access to free (proposal 6.1), so compare against what the asset holds now. */
  const accessNow = moved ? 'free' : asset.access;
  if ((draft.channelId ?? asset.channelId) && draft.access !== accessNow) {
    await setAssetAccess({ workspaceId: actor.workspaceId, role: actor.role, assetId: asset.id, access: draft.access });
  }
  return operationId;
}

/**
 * The drain's half of scheduling: every draft whose time has come is
 * published as its owner, and its build queued. One failure does not stop
 * the rest; the failed draft stays scheduled and is tried again next drain.
 */
export async function publishDueDrafts(now: Date = new Date(), limit = 20): Promise<{ published: string[]; operations: string[] }> {
  const due = await db()
    .select({ assetId: schema.postDraft.assetId, workspaceId: schema.asset.ownerWorkspaceId, userId: schema.postDraft.updatedBy })
    .from(schema.postDraft)
    .innerJoin(schema.asset, eq(schema.asset.id, schema.postDraft.assetId))
    .where(and(isNotNull(schema.postDraft.publishAt), lte(schema.postDraft.publishAt, now), isNull(schema.asset.deletedAt)))
    .limit(limit);
  const published: string[] = [];
  const operations: string[] = [];
  for (const row of due) {
    if (!row.workspaceId) continue;
    try {
      const actor = { workspaceId: row.workspaceId, role: 'owner' as const, userId: row.userId };
      const asset = await ownedEditorialAsset(db(), row.workspaceId, row.assetId);
      operations.push(await publishNow(asset, actor));
      published.push(row.assetId);
    } catch (error) {
      console.error(`scheduled publication of ${row.assetId} failed: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }
  return { published, operations };
}

export interface EditorialListItem {
  id: string;
  publicId: string;
  kind: EditorialKind;
  title: string;
  access: AssetAccess;
  live: boolean;
  publishAt: Date | null;
  draftUpdatedAt: Date | null;
  channel: { id: string; title: string } | null;
}

/** The workspace's articles, episodes and Q&As, newest first, for the editor's list. */
export async function listEditorialAssets(workspaceId: string): Promise<EditorialListItem[]> {
  const rows = await db()
    .select({
      id: schema.asset.id,
      publicId: schema.asset.publicId,
      kind: schema.asset.kind,
      title: schema.asset.title,
      access: schema.asset.access,
      lifecycleStatus: schema.asset.lifecycleStatus,
      currentVersionId: schema.asset.currentVersionId,
      publishAt: schema.postDraft.publishAt,
      draftUpdatedAt: schema.postDraft.updatedAt,
      channelId: schema.channel.id,
      channelTitle: schema.channel.title,
      createdAt: schema.asset.createdAt,
    })
    .from(schema.asset)
    .leftJoin(schema.postDraft, eq(schema.postDraft.assetId, schema.asset.id))
    .leftJoin(schema.channelAsset, eq(schema.channelAsset.assetId, schema.asset.id))
    .leftJoin(schema.channel, eq(schema.channel.id, schema.channelAsset.channelId))
    .where(
      and(
        eq(schema.asset.ownerWorkspaceId, workspaceId),
        isNull(schema.asset.deletedAt),
        inArray(schema.asset.kind, ['post', 'audio', 'qa']),
      ),
    )
    .orderBy(desc(schema.asset.createdAt))
    .limit(200);
  return rows.map((row) => ({
    id: row.id,
    publicId: row.publicId,
    kind: row.kind as EditorialKind,
    title: row.title,
    access: row.access,
    live: row.lifecycleStatus === 'published' && row.currentVersionId !== null,
    publishAt: row.publishAt,
    draftUpdatedAt: row.draftUpdatedAt,
    channel: row.channelId ? { id: row.channelId, title: row.channelTitle! } : null,
  }));
}
