/**
 * The owner's side of a showcase page: enable one for a library, edit what
 * it says, publish, disable and restore it. lib/domain/showcase.ts holds
 * the rules; this layer holds the rows.
 *
 * A page answers through an internal site key (`site_key.kind =
 * 'showcase'`): minted here with an empty allowlist, so no site can embed
 * it, and the page's own route is the only door that resolves it. Every
 * use case re-checks the role and that the library is the workspace's own,
 * since a server action is a public endpoint whatever the page renders.
 */
import { and, eq, isNull, ne } from 'drizzle-orm';
import { AppError } from '@/contracts/errors';
import { canManageLibraries, type WorkspaceRole } from '@/lib/application/libraries/delete';
import { requireOwnedLibrary } from '@/lib/application/embed/site-keys';
import { uuidv7 } from '@/lib/domain/id';
import { isLocale, type Locale } from '@/lib/i18n/locale';
import {
  parseAccent,
  parseDailyLimit,
  SITE_KEY_ACCENT_DEFAULT,
  SITE_KEY_DAILY_LIMIT_DEFAULT,
  SITE_KEY_PREFIX,
} from '@/lib/domain/site-key';
import {
  emptyShowcaseContent,
  isShowcaseAccess,
  isShowcaseExpired,
  isShowcaseKind,
  parseShowcaseExpiry,
  parseShowcasePassword,
  parseSlug,
  parseStarterQuestions,
  readShowcaseDocument,
  resolveSlugChange,
  SHOWCASE_LIMITS,
  showcasePagesAllowed,
  showcaseTransition,
  sniffImageType,
  suggestSlug,
  svgLooksSafe,
  validateShowcaseContent,
  withoutUnlistedSuffix,
  withUnlistedSuffix,
  type ShowcaseAccess,
  type ShowcaseContentError,
  type ShowcaseDocument,
  type ShowcaseKind,
  type ShowcaseStatus,
  type ShowcaseVerb,
} from '@/lib/domain/showcase';
import { hashAdminPassword } from '@/lib/application/administration/password';
import { randomHex } from '@/lib/infrastructure/crypto/tokens';
import { isObjectStoreConfigured, objectStore } from '@/lib/infrastructure/objects/store';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { countWorkspaceShowcases, showcaseEntitlement, type WorkspaceShowcaseEntitlement } from './entitlement';
import { retireShowcaseForLibrary } from './retire';
import { readShowcaseRow } from './row';

export type ShowcaseRefusal =
  | ShowcaseContentError
  | 'kind'
  | 'slug'
  | 'slug_taken'
  | 'access'
  | 'locale'
  | 'accent'
  | 'daily_limit'
  | 'starter_questions'
  | 'branding'
  | 'asset_type'
  | 'asset_size'
  | 'asset_store'
  | 'plan_limit'
  | 'password'
  | 'expires_at'
  | 'status';

/** Thrown for a bad field or a rule that does not apply; the server action turns it into a form message. */
export class ShowcaseInvalid extends AppError {
  constructor(readonly field: ShowcaseRefusal) {
    super('invalid_request', `showcase: ${field}`);
  }
}

export interface ShowcaseView {
  id: string;
  libraryId: string;
  kind: ShowcaseKind;
  slug: string;
  /** The slug without the unlisted suffix: what the owner edits. */
  slugBase: string;
  status: ShowcaseStatus;
  access: ShowcaseAccess;
  locale: Locale;
  document: ShowcaseDocument;
  starterQuestions: string[];
  accent: string;
  showBranding: boolean;
  hasLogo: boolean;
  hasScreenshot: boolean;
  dailyLimit: number;
  /** A link-only page's gate (lib/domain/showcase.ts `showcaseGate`). */
  hasPassword: boolean;
  expiresAt: string | null;
  expired: boolean;
  publishedAt: string | null;
  updatedAt: string;
  /** What the plan allows, so the panel can say why a switch is off. */
  entitlement: WorkspaceShowcaseEntitlement;
}

type Row = typeof schema.libraryShowcase.$inferSelect;

function view(row: Row, dailyLimit: number, entitlement: WorkspaceShowcaseEntitlement): ShowcaseView {
  return {
    id: row.id,
    libraryId: row.libraryId,
    kind: row.kind,
    slug: row.slug,
    slugBase: row.access === 'unlisted' ? withoutUnlistedSuffix(row.slug) : row.slug,
    status: row.status,
    access: row.access,
    ...readShowcaseRow(row),
    accent: row.accent,
    showBranding: row.showBranding,
    hasLogo: row.logoKey !== null,
    hasScreenshot: row.screenshotKey !== null,
    dailyLimit,
    hasPassword: row.passwordHash !== null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    expired: isShowcaseExpired(row.expiresAt),
    publishedAt: row.publishedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
    entitlement,
  };
}

const liveRow = (workspaceId: string, libraryId: string) =>
  and(
    eq(schema.libraryShowcase.workspaceId, workspaceId),
    eq(schema.libraryShowcase.libraryId, libraryId),
    isNull(schema.libraryShowcase.deletedAt),
  );

type Database = ReturnType<typeof db>;
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

async function loadRow(
  workspaceId: string,
  libraryId: string,
  on: Database | Tx = db(),
): Promise<(Row & { dailyLimit: number }) | null> {
  const [row] = await on
    .select({ showcase: schema.libraryShowcase, dailyLimit: schema.siteKey.dailyLimit })
    .from(schema.libraryShowcase)
    .innerJoin(schema.siteKey, eq(schema.siteKey.id, schema.libraryShowcase.siteKeyId))
    .where(liveRow(workspaceId, libraryId))
    .limit(1);
  return row ? { ...row.showcase, dailyLimit: row.dailyLimit } : null;
}

async function reload(workspaceId: string, libraryId: string, entitlement: WorkspaceShowcaseEntitlement): Promise<ShowcaseView> {
  const row = await loadRow(workspaceId, libraryId);
  if (!row) throw new AppError('internal_error', 'showcase not written');
  return view(row, row.dailyLimit, entitlement);
}

/**
 * The library's page, for its owner; null when none has been enabled. The
 * caller may hand over the entitlement it already read for the workspace,
 * so a page that reads it for the cap does not read it twice.
 */
export async function libraryShowcase(
  input: { workspaceId: string; libraryId: string },
  entitlement?: WorkspaceShowcaseEntitlement,
): Promise<ShowcaseView | null> {
  const [row, allowed] = await Promise.all([
    loadRow(input.workspaceId, input.libraryId),
    entitlement ?? showcaseEntitlement(input.workspaceId),
  ]);
  if (!row) return null;
  return view(row, row.dailyLimit, allowed);
}

async function slugTaken(slug: string, exceptId?: string, on: Database | Tx = db()): Promise<boolean> {
  const [row] = await on
    .select({ id: schema.libraryShowcase.id })
    .from(schema.libraryShowcase)
    .where(
      and(
        eq(schema.libraryShowcase.slug, slug),
        isNull(schema.libraryShowcase.deletedAt),
        exceptId ? ne(schema.libraryShowcase.id, exceptId) : undefined,
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** A slug nobody holds: the title's, else the title's with a short suffix. */
async function freeSlug(title: string, on: Database | Tx): Promise<string> {
  const base = suggestSlug(title) ?? 'page';
  if (!(await slugTaken(base, undefined, on))) return base;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = withUnlistedSuffix(base, randomHex(2));
    if (!(await slugTaken(candidate, undefined, on))) return candidate;
  }
  return withUnlistedSuffix(base, randomHex(4));
}

export interface EnableShowcaseInput {
  workspaceId: string;
  role: WorkspaceRole;
  libraryId: string;
  kind: unknown;
  locale: Locale;
}

export interface EnableShowcaseResult {
  showcase: ShowcaseView;
  /** False when the library already had a page, which is then returned as it is. */
  created: boolean;
}

/**
 * Enable a page for a library: one internal site key, one row in draft, the
 * top of the page prefilled from the library's own title and description.
 * Drafting from the library's content is a separate step (draft.ts), since
 * it costs Calls and the owner may not want it.
 *
 * The existence check, the plan cap and the insert run under the library's
 * row lock, so two enables at once (a double click, two tabs) agree on one
 * page rather than the second one failing on the unique index.
 */
export async function enableShowcase(input: EnableShowcaseInput): Promise<EnableShowcaseResult> {
  if (!canManageLibraries(input.role)) throw new AppError('access_denied', 'only a library manager can share a library');
  if (!isShowcaseKind(input.kind)) throw new ShowcaseInvalid('kind');
  const kind: ShowcaseKind = input.kind;
  await requireOwnedLibrary(input.workspaceId, input.libraryId);
  const entitlement = await showcaseEntitlement(input.workspaceId);

  const created = await db().transaction(async (tx) => {
    const [library] = await tx
      .select({ title: schema.library.title, description: schema.library.description })
      .from(schema.library)
      .where(and(eq(schema.library.id, input.libraryId), isNull(schema.library.deletedAt)))
      .for('update');
    if (!library) throw new AppError('library_not_found', 'no such library');

    if (await loadRow(input.workspaceId, input.libraryId, tx)) return false;
    const live = await countWorkspaceShowcases(input.workspaceId, tx);
    if (!showcasePagesAllowed(entitlement, live)) throw new ShowcaseInvalid('plan_limit');

    const now = new Date();
    const siteKeyId = uuidv7();
    const slug = await freeSlug(library.title, tx);
    const content = {
      ...emptyShowcaseContent(),
      name: library.title.trim().slice(0, SHOWCASE_LIMITS.name),
      summary: (library.description ?? '').trim().slice(0, SHOWCASE_LIMITS.summary),
    };
    await tx.insert(schema.siteKey).values({
      id: siteKeyId,
      workspaceId: input.workspaceId,
      libraryId: input.libraryId,
      kind: 'showcase',
      name: 'Showcase page',
      key: `${SITE_KEY_PREFIX}${randomHex(16)}`,
      allowedOrigins: [],
      dailyLimit: SITE_KEY_DAILY_LIMIT_DEFAULT,
      welcome: null,
      accent: SITE_KEY_ACCENT_DEFAULT,
      createdAt: now,
    });
    await tx.insert(schema.libraryShowcase).values({
      id: uuidv7(),
      libraryId: input.libraryId,
      workspaceId: input.workspaceId,
      siteKeyId,
      kind,
      slug,
      status: 'draft',
      access: 'public',
      locale: input.locale,
      content: { content, origin: {}, evidence: {} },
      starterQuestions: [],
      accent: SITE_KEY_ACCENT_DEFAULT,
      showBranding: true,
      createdAt: now,
      updatedAt: now,
    });
    return true;
  });

  return { showcase: await reload(input.workspaceId, input.libraryId, entitlement), created };
}

export interface UpdateShowcaseInput {
  workspaceId: string;
  role: WorkspaceRole;
  libraryId: string;
  kind?: unknown;
  /** The content as the form posts it (lib/domain/showcase.ts `validateShowcaseContent`). */
  content?: unknown;
  /** One question per line. */
  starterQuestions?: unknown;
  slug?: unknown;
  access?: unknown;
  locale?: unknown;
  accent?: unknown;
  dailyLimit?: unknown;
  showBranding?: unknown;
  /** A new password for a link-only page; empty keeps the current one. */
  password?: unknown;
  /** Drop the password. */
  clearPassword?: unknown;
  /** An ISO instant, or empty for no expiry; absent keeps the current one. */
  expiresAt?: unknown;
}

async function requireManaged(input: { workspaceId: string; role: WorkspaceRole; libraryId: string }) {
  if (!canManageLibraries(input.role)) throw new AppError('access_denied', 'only a library manager can edit a showcase page');
  const row = await loadRow(input.workspaceId, input.libraryId);
  if (!row) throw new AppError('library_not_found', 'this library has no showcase page');
  if (row.status === 'taken_down') throw new ShowcaseInvalid('status');
  return row;
}

/**
 * Edit what the page says and how it is reached. A field left out keeps
 * what the row has; a field posted is validated whole. Hand-edited text is
 * marked `manual` so a later draft does not overwrite it unasked.
 */
export async function updateShowcase(input: UpdateShowcaseInput): Promise<ShowcaseView> {
  const row = await requireManaged(input);
  const entitlement = await showcaseEntitlement(input.workspaceId);
  const current = readShowcaseDocument(row.content);
  const patch: Partial<typeof schema.libraryShowcase.$inferInsert> = {};
  let dailyLimit = row.dailyLimit;

  if (input.kind !== undefined) {
    if (!isShowcaseKind(input.kind)) throw new ShowcaseInvalid('kind');
    patch.kind = input.kind;
  }
  if (input.content !== undefined) {
    const validated = validateShowcaseContent(input.content);
    if (!validated.ok) throw new ShowcaseInvalid(validated.field);
    const origin = { ...current.origin };
    const evidence = { ...current.evidence };
    for (const field of Object.keys(validated.content) as (keyof typeof validated.content)[]) {
      if (JSON.stringify(validated.content[field]) !== JSON.stringify(current.content[field])) {
        origin[field] = 'manual';
        delete evidence[field];
      }
    }
    patch.content = { content: validated.content, origin, evidence };
  }
  if (input.starterQuestions !== undefined) {
    const parsed = parseStarterQuestions(input.starterQuestions);
    if (!parsed.ok) throw new ShowcaseInvalid('starter_questions');
    patch.starterQuestions = parsed.questions;
  }
  if (input.access !== undefined) {
    if (!isShowcaseAccess(input.access)) throw new ShowcaseInvalid('access');
    patch.access = input.access;
  }
  const access = patch.access ?? row.access;
  if (input.slug !== undefined || access !== row.access) {
    const typed = input.slug === undefined ? null : parseSlug(input.slug);
    if (input.slug !== undefined && !typed) throw new ShowcaseInvalid('slug');
    const change = resolveSlugChange({
      currentSlug: row.slug,
      currentAccess: row.access,
      typedSlug: typed,
      nextAccess: access,
      suffix: randomHex(4),
    });
    if (change.slug !== row.slug) {
      if (await slugTaken(change.slug, row.id)) throw new ShowcaseInvalid('slug_taken');
      patch.slug = change.slug;
      /* The old address keeps redirecting only to a public page: a page
         that just went unlisted must not be reachable through it. */
      patch.previousSlug = change.redirectFromOld ? row.slug : null;
    } else if (access === 'unlisted' && row.previousSlug) {
      patch.previousSlug = null;
    }
  }
  if (input.locale !== undefined) {
    if (!isLocale(input.locale)) throw new ShowcaseInvalid('locale');
    patch.locale = input.locale;
  }
  if (input.accent !== undefined && input.accent !== '') {
    const accent = parseAccent(input.accent);
    if (!accent) throw new ShowcaseInvalid('accent');
    patch.accent = accent;
  }
  if (input.dailyLimit !== undefined && input.dailyLimit !== '') {
    const parsed = parseDailyLimit(input.dailyLimit);
    if (parsed === null) throw new ShowcaseInvalid('daily_limit');
    dailyLimit = parsed;
  }
  if (input.showBranding !== undefined) {
    const show = input.showBranding === true || input.showBranding === 'true' || input.showBranding === 'on';
    if (!show && !entitlement.brandingOptional) throw new ShowcaseInvalid('branding');
    patch.showBranding = show;
  }

  /*
   * The gate belongs to a link-only page. Going public drops both the
   * password and the expiry: a page meant to be found must not have a door.
   * A changed or dropped password bumps the version, which is what shuts
   * every browser that had unlocked the old one.
   */
  if (access === 'public') {
    if (row.passwordHash !== null) {
      patch.passwordHash = null;
      patch.passwordVersion = row.passwordVersion + 1;
    }
    if (row.expiresAt !== null) patch.expiresAt = null;
  } else {
    const clear = input.clearPassword === true || input.clearPassword === 'true';
    const typed = typeof input.password === 'string' && input.password.length > 0 ? input.password : null;
    if (clear) {
      if (row.passwordHash !== null) {
        patch.passwordHash = null;
        patch.passwordVersion = row.passwordVersion + 1;
      }
    } else if (typed !== null) {
      const password = parseShowcasePassword(typed);
      if (!password) throw new ShowcaseInvalid('password');
      patch.passwordHash = await hashAdminPassword(password);
      patch.passwordVersion = row.passwordVersion + 1;
    }
    if (input.expiresAt !== undefined) {
      const expiry = parseShowcaseExpiry(input.expiresAt);
      if (expiry === undefined) throw new ShowcaseInvalid('expires_at');
      patch.expiresAt = expiry;
    }
  }

  patch.updatedAt = new Date();
  await db().transaction(async (tx) => {
    await tx.update(schema.libraryShowcase).set(patch).where(eq(schema.libraryShowcase.id, row.id));
    if (dailyLimit !== row.dailyLimit) {
      await tx.update(schema.siteKey).set({ dailyLimit }).where(eq(schema.siteKey.id, row.siteKeyId));
    }
  });
  return reload(input.workspaceId, input.libraryId, entitlement);
}

/** Publish, disable or restore: the owner's three moves (lib/domain/showcase.ts `showcaseTransition`). */
export async function applyShowcaseVerb(input: {
  workspaceId: string;
  role: WorkspaceRole;
  libraryId: string;
  verb: unknown;
}): Promise<ShowcaseView> {
  const row = await requireManaged(input);
  if (input.verb !== 'publish' && input.verb !== 'disable' && input.verb !== 'restore') throw new ShowcaseInvalid('status');
  const verb: ShowcaseVerb = input.verb;
  const next = showcaseTransition(row.status, verb);
  if (!next) throw new ShowcaseInvalid('status');
  const now = new Date();
  await db()
    .update(schema.libraryShowcase)
    .set({
      status: next,
      updatedAt: now,
      ...(next === 'published' ? { publishedAt: row.publishedAt ?? now, disabledAt: null } : {}),
      ...(next === 'disabled' ? { disabledAt: now } : {}),
    })
    .where(eq(schema.libraryShowcase.id, row.id));
  return reload(input.workspaceId, input.libraryId, await showcaseEntitlement(input.workspaceId));
}

/**
 * Delete the page so the library can start over with a fresh one. The row
 * is tombstoned exactly as a deleted library's page is
 * (`retireShowcaseForLibrary`): the slug is freed, the leads and the custom
 * host go with the page, the internal site key is revoked. The logo and
 * screenshot leave the object store afterwards, best-effort. A page the
 * platform took down cannot be deleted by its owner -- deleting and
 * enabling again would be a way around the take-down -- which
 * `requireManaged` already refuses.
 */
export async function deleteShowcase(input: { workspaceId: string; role: WorkspaceRole; libraryId: string }): Promise<void> {
  const row = await requireManaged(input);
  const now = new Date();
  await db().transaction(async (tx) => {
    await retireShowcaseForLibrary(tx, input.libraryId, now);
  });
  if (isObjectStoreConfigured()) {
    for (const key of [row.logoKey, row.screenshotKey]) {
      if (key) await objectStore().delete(key).catch(() => {});
    }
  }
}

/* ------------------------------------------------------------------ assets */

export type ShowcaseAssetKind = 'logo' | 'screenshot';

/** Object keys never carry user input: the page's id and the asset's role. */
export function showcaseAssetKey(showcaseId: string, kind: ShowcaseAssetKind): string {
  return `showcase/${showcaseId}/${kind}`;
}

/**
 * Store a logo or screenshot; a second upload replaces the first. The type
 * is read off the bytes, not the browser's claim, and an SVG is kept only
 * when it carries nothing that could run or load from elsewhere.
 */
export async function uploadShowcaseAsset(input: {
  workspaceId: string;
  role: WorkspaceRole;
  libraryId: string;
  kind: ShowcaseAssetKind;
  bytes: Uint8Array;
}): Promise<ShowcaseView> {
  const row = await requireManaged(input);
  const max = input.kind === 'logo' ? SHOWCASE_LIMITS.logoBytes : SHOWCASE_LIMITS.screenshotBytes;
  if (input.bytes.byteLength === 0 || input.bytes.byteLength > max) throw new ShowcaseInvalid('asset_size');
  const contentType = sniffImageType(input.bytes);
  if (!contentType) throw new ShowcaseInvalid('asset_type');
  if (contentType === 'image/svg+xml' && !svgLooksSafe(new TextDecoder().decode(input.bytes))) {
    throw new ShowcaseInvalid('asset_type');
  }
  if (!isObjectStoreConfigured()) throw new ShowcaseInvalid('asset_store');
  const key = showcaseAssetKey(row.id, input.kind);
  await objectStore().put(key, input.bytes, contentType);
  await db()
    .update(schema.libraryShowcase)
    .set({ ...(input.kind === 'logo' ? { logoKey: key } : { screenshotKey: key }), updatedAt: new Date() })
    .where(eq(schema.libraryShowcase.id, row.id));
  return reload(input.workspaceId, input.libraryId, await showcaseEntitlement(input.workspaceId));
}

export async function removeShowcaseAsset(input: {
  workspaceId: string;
  role: WorkspaceRole;
  libraryId: string;
  kind: ShowcaseAssetKind;
}): Promise<ShowcaseView> {
  const row = await requireManaged(input);
  const key = input.kind === 'logo' ? row.logoKey : row.screenshotKey;
  if (key && isObjectStoreConfigured()) await objectStore().delete(key).catch(() => {});
  await db()
    .update(schema.libraryShowcase)
    .set({ ...(input.kind === 'logo' ? { logoKey: null } : { screenshotKey: null }), updatedAt: new Date() })
    .where(eq(schema.libraryShowcase.id, row.id));
  return reload(input.workspaceId, input.libraryId, await showcaseEntitlement(input.workspaceId));
}
