/**
 * Which websites have actually installed the widget. requirement.md 9.4.
 *
 * A key's allowlist says where the widget *may* appear; the owner also wants
 * to know where it *does*. The two places a site reveals itself are the widget
 * page being served to its parent (the loader fetches it on every page view
 * where the snippet is installed) and a question being admitted from it. Both leave a mark
 * here, per key and origin, written off the request path: a lost write costs
 * a count, failing a visitor over a statistic would cost the owner a visitor.
 *
 * The dashboard's widget screen reads the marks back next to every live key
 * of the workspace, so the owner sees each allowed origin as either reached
 * or still waiting for the snippet.
 */
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from '@/lib/domain/id';
import { normaliseOrigin, widgetReady } from '@/lib/domain/site-key';
import { db, schema } from '@/lib/infrastructure/postgres/client';

export type WidgetSighting = 'load' | 'question';

/**
 * Record one sighting of a key's widget on `origin`. The origin must already
 * have passed the allowlist; it is normalised here only so the row matches
 * `allowedOrigins` exactly. Resolves once written; callers on the request
 * path do not wait for it.
 */
export async function recordWidgetOrigin(
  siteKeyId: string,
  origin: string | null | undefined,
  sighting: WidgetSighting,
): Promise<void> {
  const normalised = origin ? normaliseOrigin(origin) : null;
  if (!normalised) return;
  const now = new Date();
  const load = sighting === 'load' ? 1 : 0;
  const question = sighting === 'question' ? 1 : 0;
  await db()
    .insert(schema.siteKeyOrigin)
    .values({
      id: uuidv7(),
      siteKeyId,
      origin: normalised,
      loads: load,
      questions: question,
      firstSeenAt: now,
      lastSeenAt: now,
    })
    .onConflictDoUpdate({
      target: [schema.siteKeyOrigin.siteKeyId, schema.siteKeyOrigin.origin],
      set: {
        loads: sql`${schema.siteKeyOrigin.loads} + ${load}`,
        questions: sql`${schema.siteKeyOrigin.questions} + ${question}`,
        lastSeenAt: now,
      },
    });
}

/** Fire-and-forget form for Route Handlers: never throws, never awaited. */
export function noteWidgetOrigin(
  siteKeyId: string,
  origin: string | null | undefined,
  sighting: WidgetSighting,
): void {
  recordWidgetOrigin(siteKeyId, origin, sighting).catch(() => {});
}

export interface WidgetSiteOrigin {
  origin: string;
  /** Null while the snippet has not been seen on this origin. */
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  loads: number;
  questions: number;
}

export interface WidgetSiteKey {
  id: string;
  name: string;
  key: string;
  accent: string;
  dailyLimit: number;
  createdAt: string;
  lastUsedAt: string | null;
  asset: {
    id: string;
    publicId: string;
    title: string;
    /** Published with a current version: the widget answers right now. */
    ready: boolean;
  };
  /** Every allowed origin, in the owner's order, with what has been seen there. */
  origins: WidgetSiteOrigin[];
}

/**
 * Every live site key of the workspace with its asset and, per allowed
 * origin, whether the widget has been seen there. An origin the owner removed
 * from the allowlist keeps its row but is no longer listed: the browser
 * refuses it now, so it is not an integrated site.
 */
export async function listWorkspaceWidgetSites(workspaceId: string): Promise<WidgetSiteKey[]> {
  const rows = await db()
    .select({
      id: schema.siteKey.id,
      name: schema.siteKey.name,
      key: schema.siteKey.key,
      accent: schema.siteKey.accent,
      dailyLimit: schema.siteKey.dailyLimit,
      allowedOrigins: schema.siteKey.allowedOrigins,
      createdAt: schema.siteKey.createdAt,
      lastUsedAt: schema.siteKey.lastUsedAt,
      assetId: schema.asset.id,
      assetPublicId: schema.asset.publicId,
      assetTitle: schema.asset.title,
      lifecycleStatus: schema.asset.lifecycleStatus,
      currentVersionId: schema.asset.currentVersionId,
    })
    .from(schema.siteKey)
    .innerJoin(schema.asset, eq(schema.asset.id, schema.siteKey.assetId))
    .where(
      and(
        eq(schema.siteKey.workspaceId, workspaceId),
        eq(schema.siteKey.kind, 'embed'),
        isNull(schema.siteKey.revokedAt),
        isNull(schema.asset.deletedAt),
      ),
    )
    .orderBy(desc(schema.siteKey.createdAt));
  if (rows.length === 0) return [];

  const sightings = await db()
    .select()
    .from(schema.siteKeyOrigin)
    .where(
      inArray(
        schema.siteKeyOrigin.siteKeyId,
        rows.map((row) => row.id),
      ),
    );
  const seen = new Map<string, typeof schema.siteKeyOrigin.$inferSelect>();
  for (const row of sightings) seen.set(`${row.siteKeyId}\n${row.origin}`, row);

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    key: row.key,
    accent: row.accent,
    dailyLimit: row.dailyLimit,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    asset: {
      id: row.assetId,
      publicId: row.assetPublicId,
      title: row.assetTitle,
      ready: widgetReady({
        lifecycleStatus: row.lifecycleStatus,
        hasCurrentVersion: row.currentVersionId !== null,
      }),
    },
    origins: row.allowedOrigins.map((origin) => {
      const mark = seen.get(`${row.id}\n${origin}`);
      return {
        origin,
        firstSeenAt: mark?.firstSeenAt.toISOString() ?? null,
        lastSeenAt: mark?.lastSeenAt.toISOString() ?? null,
        loads: mark?.loads ?? 0,
        questions: mark?.questions ?? 0,
      };
    }),
  }));
}
