/**
 * A workspace's own channels: create, edit, delete, and moving assets in and
 * out. agent-first-proposal.md 6.1, 6.11.
 *
 * P1 drives these from plain dashboard clicks; the agent's confirmation gate
 * (proposal 5.2) wraps the same functions in P2, so every rule lives here and
 * not in the screen: the role check, ownership of both the asset and the
 * channel, "one asset, at most one channel", `access` reset on leaving, and
 * the two checks that guard anything becoming public -- a rights declaration
 * that permits it, and proven control of a website or repository source.
 *
 * A channel that is not the caller's answers `not_found`, the same as one
 * that does not exist (architecture.md 5.2).
 */
import { and, asc, count, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { AppError } from '@/contracts/errors';
import { needsClaimForPublic, type AssetKind } from '@/lib/domain/asset';
import {
  ChannelRefused,
  draftChannel,
  type ChannelStatus,
  type ChannelVisibility,
} from '@/lib/domain/channel';
import { uuidv7 } from '@/lib/domain/id';
import { readRightsDeclaration, rightsAllowPublic } from '@/lib/domain/rights';
import { db, schema, type Database } from '@/lib/infrastructure/postgres/client';
import { canManageLibraries, type WorkspaceRole } from '@/lib/application/libraries/delete';
import { refreshChannelProfile } from './profile';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

function assertManager(role: WorkspaceRole): void {
  if (!canManageLibraries(role)) {
    throw new AppError('access_denied', 'only a workspace owner or admin can manage channels');
  }
}

export interface WorkspaceChannel {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  visibility: ChannelVisibility;
  status: ChannelStatus;
  assetCount: number;
  createdAt: string;
  updatedAt: string;
}

/** The workspace's channels, newest first, with how many assets each holds. */
export async function listWorkspaceChannels(workspaceId: string): Promise<WorkspaceChannel[]> {
  const database = db();
  const counts = database
    .select({ channelId: schema.channelAsset.channelId, n: count().as('n') })
    .from(schema.channelAsset)
    .innerJoin(schema.library, eq(schema.library.id, schema.channelAsset.assetId))
    .where(isNull(schema.library.deletedAt))
    .groupBy(schema.channelAsset.channelId)
    .as('counts');
  const rows = await database
    .select({
      id: schema.channel.id,
      slug: schema.channel.slug,
      title: schema.channel.title,
      description: schema.channel.description,
      visibility: schema.channel.visibility,
      status: schema.channel.status,
      createdAt: schema.channel.createdAt,
      updatedAt: schema.channel.updatedAt,
      assetCount: sql<number>`coalesce(${counts.n}, 0)::int`,
    })
    .from(schema.channel)
    .leftJoin(counts, eq(counts.channelId, schema.channel.id))
    .where(eq(schema.channel.workspaceId, workspaceId))
    .orderBy(desc(schema.channel.createdAt), desc(schema.channel.id));
  return rows.map((row) => ({
    ...row,
    assetCount: Number(row.assetCount),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

/* ------------------------------------------------------------------ create */

export interface CreateChannelInput {
  workspaceId: string;
  role: WorkspaceRole;
  slug: string;
  title: string;
  description?: string | null;
  visibility?: string;
}

/** A new channel, public unless asked otherwise (proposal 6.1). */
export async function createChannel(input: CreateChannelInput): Promise<{ id: string; slug: string }> {
  assertManager(input.role);
  const draft = draftChannel(input);
  const id = uuidv7();
  try {
    await db().insert(schema.channel).values({
      id,
      slug: draft.slug,
      workspaceId: input.workspaceId,
      title: draft.title,
      description: draft.description,
      visibility: draft.visibility,
    });
  } catch (error) {
    if (isUniqueViolation(error, 'channel_slug_uq')) {
      throw new ChannelRefused('slug_taken', 'that channel address is taken');
    }
    throw error;
  }
  return { id, slug: draft.slug };
}

/* -------------------------------------------------------------------- edit */

export interface EditChannelInput {
  workspaceId: string;
  role: WorkspaceRole;
  channelId: string;
  title: string;
  description?: string | null;
  visibility?: string;
}

/**
 * Edits title, description and visibility. The slug is the channel's
 * address and its card's tenant, and does not move. Turning a private
 * channel public makes every asset in it public at once, so each one has to
 * pass the same checks a move into a public channel does.
 */
export async function editChannel(input: EditChannelInput): Promise<void> {
  assertManager(input.role);
  await db().transaction(async (tx) => {
    const channel = await ownedChannel(tx, input.workspaceId, input.channelId, true);
    /* A field left out keeps its value: an edit is never a silent move to public. */
    const draft = draftChannel({ ...input, slug: channel.slug, visibility: input.visibility ?? channel.visibility });
    if (draft.visibility === 'public' && channel.visibility !== 'public') {
      const assets = await tx
        .select({ id: schema.channelAsset.assetId })
        .from(schema.channelAsset)
        .where(eq(schema.channelAsset.channelId, channel.id));
      for (const asset of assets) await assertMayBePublic(tx, asset.id);
    }
    await tx
      .update(schema.channel)
      .set({
        title: draft.title,
        description: draft.description,
        visibility: draft.visibility,
        updatedAt: new Date(),
      })
      .where(eq(schema.channel.id, channel.id));
  });
  await refreshChannelProfile(input.channelId);
}

/* ------------------------------------------------------------------ delete */

/**
 * Deletes a channel. Its assets are not deleted: they leave it, back to their
 * owner alone, with `access` reset to free like any other move out.
 */
export async function deleteChannel(input: {
  workspaceId: string;
  role: WorkspaceRole;
  channelId: string;
}): Promise<{ releasedAssets: number }> {
  assertManager(input.role);
  return db().transaction(async (tx) => {
    const channel = await ownedChannel(tx, input.workspaceId, input.channelId, true);
    const members = await tx
      .delete(schema.channelAsset)
      .where(eq(schema.channelAsset.channelId, channel.id))
      .returning({ assetId: schema.channelAsset.assetId });
    if (members.length > 0) {
      await tx
        .update(schema.library)
        .set({ access: 'free' })
        .where(inArray(schema.library.id, members.map((member) => member.assetId)));
    }
    await tx.delete(schema.channel).where(eq(schema.channel.id, channel.id));
    return { releasedAssets: members.length };
  });
}

/* -------------------------------------------------------------------- move */

export interface MoveAssetInput {
  workspaceId: string;
  role: WorkspaceRole;
  assetId: string;
  /** The channel to move into, or null to take the asset out of any channel. */
  channelId: string | null;
}

export interface MoveAssetResult {
  /** Where the asset was. */
  from: string | null;
  /** Where it is now. */
  to: string | null;
  /** True when the move put the asset in front of the public. */
  madePublic: boolean;
}

/**
 * Puts an asset into one of the workspace's channels, moves it to another,
 * or takes it out (proposal 6.1, 5.1 `move_asset`). Any change of channel
 * resets `access` to free: it describes the asset inside one channel and is
 * not carried to the next. A move into a public channel is refused unless the
 * asset may be public (`assertMayBePublic`).
 */
export async function moveAsset(input: MoveAssetInput): Promise<MoveAssetResult> {
  assertManager(input.role);
  const result = await db().transaction(async (tx) => {
    const asset = await ownedAsset(tx, input.workspaceId, input.assetId);
    const [current] = await tx
      .select({ channelId: schema.channelAsset.channelId })
      .from(schema.channelAsset)
      .where(eq(schema.channelAsset.assetId, asset.id))
      .for('update');
    const from = current?.channelId ?? null;

    if (input.channelId === null) {
      if (from) {
        await tx.delete(schema.channelAsset).where(eq(schema.channelAsset.assetId, asset.id));
        await tx.update(schema.library).set({ access: 'free' }).where(eq(schema.library.id, asset.id));
      }
      return { from, to: null, madePublic: false };
    }

    /* Locked, as `editChannel` locks it: a channel turned public while this
       move runs would otherwise admit an asset that skipped the public gates. */
    const target = await ownedChannel(tx, input.workspaceId, input.channelId, true);
    if (target.status === 'suspended') {
      throw new ChannelRefused('suspended', 'this channel is suspended');
    }
    if (from === target.id) return { from, to: target.id, madePublic: false };
    if (target.visibility === 'public') await assertMayBePublic(tx, asset.id);

    const now = new Date();
    await tx
      .insert(schema.channelAsset)
      .values({ assetId: asset.id, channelId: target.id, publishedAt: now })
      .onConflictDoUpdate({
        target: schema.channelAsset.assetId,
        set: { channelId: target.id, publishedAt: now, pinnedAt: null, scheduledAt: null },
      });
    await tx.update(schema.library).set({ access: 'free' }).where(eq(schema.library.id, asset.id));
    await tx.update(schema.channel).set({ updatedAt: now }).where(eq(schema.channel.id, target.id));
    return { from, to: target.id, madePublic: target.visibility === 'public' };
  });

  /* The aggregate profiles follow membership; best-effort, never the move's failure. */
  for (const channelId of new Set([result.from, result.to])) {
    if (channelId) await refreshChannelProfile(channelId).catch(() => {});
  }
  return result;
}

/** Pins an asset to the top of its channel's stream, or unpins it. */
export async function pinAsset(input: {
  workspaceId: string;
  role: WorkspaceRole;
  assetId: string;
  pinned: boolean;
}): Promise<void> {
  assertManager(input.role);
  await db().transaction(async (tx) => {
    const asset = await ownedAsset(tx, input.workspaceId, input.assetId);
    const updated = await tx
      .update(schema.channelAsset)
      .set({ pinnedAt: input.pinned ? new Date() : null })
      .where(eq(schema.channelAsset.assetId, asset.id))
      .returning({ assetId: schema.channelAsset.assetId });
    if (updated.length === 0) throw new ChannelRefused('not_found', 'the asset is in no channel');
  });
}

/* --------------------------------------------------------------- the gates */

/**
 * Whether an asset may be shown to the public (proposal 6.11):
 *
 * - its rights declaration is on the row and permits public distribution
 *   (lib/domain/rights.ts) -- every kind, since the creator declares it;
 * - for a website or a repository, control of the source is proven: a
 *   verified claim held by the owner, or, for a repository, the import check
 *   that it is the owner's own on GitHub, which creation already passed and
 *   remembered on the source (`repositoryId`).
 */
async function assertMayBePublic(tx: Tx, assetId: string): Promise<void> {
  const [asset] = await tx
    .select({
      id: schema.library.id,
      kind: schema.library.kind,
      ownerWorkspaceId: schema.library.ownerWorkspaceId,
      rights: schema.library.rightsDeclaration,
    })
    .from(schema.library)
    .where(eq(schema.library.id, assetId))
    .limit(1);
  if (!asset) throw new ChannelRefused('asset_not_found', 'no such asset');

  const rights = readRightsDeclaration(asset.rights);
  if (!rights || !rightsAllowPublic(rights)) {
    throw new ChannelRefused('rights_required', 'declare your rights to this asset before making it public');
  }
  if (needsClaimForPublic(asset.kind as AssetKind) && !(await controlProven(tx, asset))) {
    throw new ChannelRefused('claim_required', 'prove you control this source before making it public');
  }
}

async function controlProven(
  tx: Tx,
  asset: { id: string; kind: string; ownerWorkspaceId: string | null },
): Promise<boolean> {
  if (!asset.ownerWorkspaceId) return false;
  const [claim] = await tx
    .select({ id: schema.libraryClaim.id })
    .from(schema.libraryClaim)
    .where(
      and(
        eq(schema.libraryClaim.libraryId, asset.id),
        eq(schema.libraryClaim.claimantWorkspaceId, asset.ownerWorkspaceId),
        eq(schema.libraryClaim.status, 'verified'),
      ),
    )
    .limit(1);
  if (claim) return true;
  if (asset.kind !== 'github') return false;
  const [source] = await tx
    .select({ config: schema.source.config })
    .from(schema.source)
    .where(and(eq(schema.source.libraryId, asset.id), eq(schema.source.type, 'github')))
    .orderBy(asc(schema.source.id))
    .limit(1);
  return typeof source?.config?.repositoryId === 'string' || typeof source?.config?.repositoryId === 'number';
}

/* ----------------------------------------------------------------- loaders */

async function ownedChannel(
  tx: Tx,
  workspaceId: string,
  channelId: string,
  lock: boolean,
): Promise<{ id: string; slug: string; visibility: ChannelVisibility; status: ChannelStatus }> {
  if (!UUID.test(channelId)) throw new ChannelRefused('not_found', 'no such channel');
  const query = tx
    .select({
      id: schema.channel.id,
      slug: schema.channel.slug,
      visibility: schema.channel.visibility,
      status: schema.channel.status,
    })
    .from(schema.channel)
    .where(and(eq(schema.channel.id, channelId), eq(schema.channel.workspaceId, workspaceId)));
  const [row] = lock ? await query.for('update') : await query.limit(1);
  if (!row) throw new ChannelRefused('not_found', 'no such channel');
  return row;
}

async function ownedAsset(tx: Tx, workspaceId: string, assetId: string): Promise<{ id: string }> {
  if (!UUID.test(assetId)) throw new ChannelRefused('asset_not_found', 'no such asset');
  const [row] = await tx
    .select({ id: schema.library.id })
    .from(schema.library)
    .where(
      and(
        eq(schema.library.id, assetId),
        eq(schema.library.ownerWorkspaceId, workspaceId),
        eq(schema.library.isPlatformLibrary, false),
        ne(schema.library.lifecycleStatus, 'archived'),
        isNull(schema.library.deletedAt),
      ),
    )
    .for('update');
  if (!row) throw new ChannelRefused('asset_not_found', 'no such asset');
  return row;
}

/** The driver wraps the pg error; the constraint name sits on the cause. */
function isUniqueViolation(error: unknown, constraint: string): boolean {
  const messages = [
    error instanceof Error ? error.message : '',
    error instanceof Error && error.cause instanceof Error ? error.cause.message : '',
  ].join(' ');
  return messages.includes(constraint);
}
