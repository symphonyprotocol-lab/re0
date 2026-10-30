/**
 * The visitor's side of a showcase page: what `/s/[slug]` renders, and the
 * site key principal its questions run as.
 *
 * A page is reachable only while published; a disabled, taken-down or
 * missing one is the same 404, so an address says nothing about whether a
 * page ever existed. A slug the page used to have redirects to the one it
 * has now, so a link already shared survives a rename.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { resolveSiteKey, type SiteKeyPrincipal } from '@/lib/application/embed/resolve';
import type { Locale } from '@/lib/i18n/locale';
import {
  showcaseIndexable,
  showcaseRedirectable,
  showcaseVisible,
  type ShowcaseAccess,
  type ShowcaseDocument,
  type ShowcaseKind,
} from '@/lib/domain/showcase';
import { widgetReady } from '@/lib/domain/site-key';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { liveHostSql } from './live-host';
import { readShowcaseRow } from './row';

export interface PublicShowcase {
  id: string;
  slug: string;
  kind: ShowcaseKind;
  access: ShowcaseAccess;
  locale: Locale;
  document: ShowcaseDocument;
  starterQuestions: string[];
  accent: string;
  showBranding: boolean;
  hasLogo: boolean;
  hasScreenshot: boolean;
  /** For search engines: public and published. */
  indexable: boolean;
  /** The asset can answer right now (published with a current version). */
  ready: boolean;
  assetTitle: string;
  /** Cache-busting for the asset routes. */
  updatedAt: string;
  /** The gate (lib/domain/showcase.ts `showcaseGate`): checked by the page and every route of it. */
  gate: ShowcaseGateInput;
  /** The owner's own host the page is live on, when any: a second origin its routes accept. */
  customHost: string | null;
  /** The owner looking at an unpublished page: rendered, not answering. */
  preview?: boolean;
}

/** What the gate decision needs of a page, plus the id the unlock cookie is named after. */
export interface ShowcaseGateInput {
  showcaseId: string;
  hasPassword: boolean;
  passwordVersion: number;
  expiresAt: string | null;
}

function gateOf(s: Pick<typeof schema.assetShowcase.$inferSelect, 'id' | 'passwordHash' | 'passwordVersion' | 'expiresAt'>): ShowcaseGateInput {
  return {
    showcaseId: s.id,
    hasPassword: s.passwordHash !== null,
    passwordVersion: s.passwordVersion,
    expiresAt: s.expiresAt?.toISOString() ?? null,
  };
}

export type ShowcaseLookup =
  | { kind: 'page'; page: PublicShowcase }
  | { kind: 'redirect'; slug: string }
  | { kind: 'none' };

/** The page's live custom host, when it has one (live-host.ts). */
const liveHost = liveHostSql;

const columns = {
  showcase: schema.assetShowcase,
  customHost: liveHost,
  assetTitle: schema.asset.title,
  lifecycleStatus: schema.asset.lifecycleStatus,
  currentVersionId: schema.asset.currentVersionId,
  assetDeletedAt: schema.asset.deletedAt,
};

function toPublic(row: { showcase: typeof schema.assetShowcase.$inferSelect; customHost: string | null; assetTitle: string; lifecycleStatus: string; currentVersionId: string | null }): PublicShowcase {
  const s = row.showcase;
  return {
    id: s.id,
    slug: s.slug,
    kind: s.kind,
    access: s.access,
    ...readShowcaseRow(s),
    accent: s.accent,
    showBranding: s.showBranding,
    hasLogo: s.logoKey !== null,
    hasScreenshot: s.screenshotKey !== null,
    indexable: showcaseIndexable({ status: s.status, access: s.access }),
    ready: widgetReady({ lifecycleStatus: row.lifecycleStatus, hasCurrentVersion: row.currentVersionId !== null }),
    assetTitle: row.assetTitle,
    updatedAt: s.updatedAt.toISOString(),
    gate: gateOf(s),
    customHost: row.customHost ?? null,
  };
}

/**
 * The page at `slug`, a redirect to where it moved, or nothing. With
 * `ownerWorkspaceId`, a page that is not published is still returned when
 * it belongs to that workspace -- the owner's preview of a draft -- and the
 * result says so, so the page can keep its Q&A shut.
 */
export async function lookupShowcase(
  slug: string,
  options: { ownerWorkspaceId?: string | null } = {},
): Promise<ShowcaseLookup> {
  if (!/^[a-z0-9-]{3,48}$/.test(slug)) return { kind: 'none' };
  const database = db();
  const [row] = await database
    .select(columns)
    .from(schema.assetShowcase)
    .innerJoin(schema.asset, eq(schema.asset.id, schema.assetShowcase.assetId))
    .where(and(eq(schema.assetShowcase.slug, slug), isNull(schema.assetShowcase.deletedAt)))
    .limit(1);
  if (row) {
    if (row.assetDeletedAt) return { kind: 'none' };
    if (showcaseVisible(row.showcase.status)) return { kind: 'page', page: toPublic(row) };
    const owner = options.ownerWorkspaceId && row.showcase.workspaceId === options.ownerWorkspaceId;
    if (owner && row.showcase.status !== 'taken_down') return { kind: 'page', page: { ...toPublic(row), preview: true } };
    return { kind: 'none' };
  }
  const [moved] = await database
    .select({ slug: schema.assetShowcase.slug, status: schema.assetShowcase.status, access: schema.assetShowcase.access })
    .from(schema.assetShowcase)
    .where(and(eq(schema.assetShowcase.previousSlug, slug), isNull(schema.assetShowcase.deletedAt)))
    .limit(1);
  if (moved && showcaseRedirectable(moved)) return { kind: 'redirect', slug: moved.slug };
  return { kind: 'none' };
}

/**
 * The object key behind a page's logo or screenshot, for the asset routes,
 * with the gate the route must check unless the owner is previewing. Null
 * when there is no such asset or the page is not visible.
 */
export async function showcaseAssetKeyFor(
  slug: string,
  kind: 'logo' | 'screenshot',
  options: { ownerWorkspaceId?: string | null } = {},
): Promise<{ key: string; gate: ShowcaseGateInput; owner: boolean } | null> {
  const [row] = await db()
    .select({
      id: schema.assetShowcase.id,
      logoKey: schema.assetShowcase.logoKey,
      screenshotKey: schema.assetShowcase.screenshotKey,
      status: schema.assetShowcase.status,
      workspaceId: schema.assetShowcase.workspaceId,
      passwordHash: schema.assetShowcase.passwordHash,
      passwordVersion: schema.assetShowcase.passwordVersion,
      expiresAt: schema.assetShowcase.expiresAt,
    })
    .from(schema.assetShowcase)
    .where(and(eq(schema.assetShowcase.slug, slug), isNull(schema.assetShowcase.deletedAt)))
    .limit(1);
  if (!row) return null;
  const owner = Boolean(options.ownerWorkspaceId && row.workspaceId === options.ownerWorkspaceId);
  if (!showcaseVisible(row.status) && !owner) return null;
  const key = kind === 'logo' ? row.logoKey : row.screenshotKey;
  return key ? { key, gate: gateOf(row), owner } : null;
}

export interface ShowcasePrincipal {
  showcaseId: string;
  slug: string;
  principal: SiteKeyPrincipal;
  gate: ShowcaseGateInput;
  customHost: string | null;
}

/**
 * Who a published page's question runs as: its internal site key, resolved
 * the way the widget's is (owner account usable, key not revoked, asset
 * alive). A page that is not visible resolves to nothing.
 */
export async function resolveShowcasePrincipal(slug: string): Promise<ShowcasePrincipal | null> {
  if (!/^[a-z0-9-]{3,48}$/.test(slug)) return null;
  const [row] = await db()
    .select({
      showcase: {
        id: schema.assetShowcase.id,
        slug: schema.assetShowcase.slug,
        status: schema.assetShowcase.status,
        passwordHash: schema.assetShowcase.passwordHash,
        passwordVersion: schema.assetShowcase.passwordVersion,
        expiresAt: schema.assetShowcase.expiresAt,
      },
      customHost: liveHost,
      key: schema.siteKey.key,
    })
    .from(schema.assetShowcase)
    .innerJoin(schema.siteKey, eq(schema.siteKey.id, schema.assetShowcase.siteKeyId))
    .where(and(eq(schema.assetShowcase.slug, slug), isNull(schema.assetShowcase.deletedAt)))
    .limit(1);
  if (!row || !showcaseVisible(row.showcase.status)) return null;
  try {
    const principal = await resolveSiteKey(row.key);
    return { showcaseId: row.showcase.id, slug: row.showcase.slug, principal, gate: gateOf(row.showcase), customHost: row.customHost ?? null };
  } catch {
    return null;
  }
}

/** What the unlock route needs of a visible page: its password hash and version; null when the page has no password or is not visible. */
export async function showcasePasswordFor(slug: string): Promise<{ showcaseId: string; hash: string; gate: ShowcaseGateInput; customHost: string | null } | null> {
  if (!/^[a-z0-9-]{3,48}$/.test(slug)) return null;
  const [row] = await db()
    .select({
      id: schema.assetShowcase.id,
      status: schema.assetShowcase.status,
      passwordHash: schema.assetShowcase.passwordHash,
      passwordVersion: schema.assetShowcase.passwordVersion,
      expiresAt: schema.assetShowcase.expiresAt,
      customHost: liveHost,
    })
    .from(schema.assetShowcase)
    .where(and(eq(schema.assetShowcase.slug, slug), isNull(schema.assetShowcase.deletedAt)))
    .limit(1);
  if (!row || !showcaseVisible(row.status) || row.passwordHash === null) return null;
  return { showcaseId: row.id, hash: row.passwordHash, gate: gateOf(row), customHost: row.customHost ?? null };
}
