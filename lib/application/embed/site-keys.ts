/**
 * Site key management: the owner's side of the website widget.
 * requirement.md 9.4, lib/domain/site-key.ts.
 *
 * A key belongs to one library of the workspace. Minting, editing and
 * revoking are a library manager's rights (the same role that edits the
 * library), and every use case re-checks both the role and that the library
 * is the workspace's own: a server action is a public endpoint whatever the
 * page renders.
 */
import { and, count, desc, eq, isNull } from 'drizzle-orm';
import { AppError } from '@/contracts/errors';
import { canManageLibraries, type WorkspaceRole } from '@/lib/application/libraries';
import { uuidv7 } from '@/lib/domain/id';
import {
  parseAccent,
  parseDailyLimit,
  parseOrigins,
  SITE_KEY_ACCENT_DEFAULT,
  SITE_KEY_DAILY_LIMIT_DEFAULT,
  SITE_KEY_PREFIX,
  SITE_KEY_WELCOME_MAX,
} from '@/lib/domain/site-key';
import { randomHex } from '@/lib/infrastructure/crypto/tokens';
import { db, schema } from '@/lib/infrastructure/postgres/client';

export interface SiteKeyView {
  id: string;
  name: string;
  /** The publishable key, in full: it is not a secret. */
  key: string;
  allowedOrigins: string[];
  dailyLimit: number;
  welcome: string | null;
  accent: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** How many live keys one library may have. Enough for staging and production. */
export const SITE_KEYS_PER_LIBRARY = 5;

function view(row: typeof schema.siteKey.$inferSelect): SiteKeyView {
  return {
    id: row.id,
    name: row.name,
    key: row.key,
    allowedOrigins: row.allowedOrigins,
    dailyLimit: row.dailyLimit,
    welcome: row.welcome,
    accent: row.accent,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  };
}

/** The library must be this workspace's own and alive; else `library_not_found`. Shared with the FAQ use cases. */
export async function requireOwnedLibrary(workspaceId: string, libraryId: string): Promise<void> {
  const [row] = await db()
    .select({ id: schema.library.id })
    .from(schema.library)
    .where(
      and(
        eq(schema.library.id, libraryId),
        eq(schema.library.ownerWorkspaceId, workspaceId),
        eq(schema.library.isPlatformLibrary, false),
        isNull(schema.library.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw new AppError('library_not_found', 'no such library in this workspace');
}

export async function listSiteKeys(input: {
  workspaceId: string;
  libraryId: string;
}): Promise<SiteKeyView[]> {
  const rows = await db()
    .select()
    .from(schema.siteKey)
    .where(
      and(
        eq(schema.siteKey.workspaceId, input.workspaceId),
        eq(schema.siteKey.libraryId, input.libraryId),
        isNull(schema.siteKey.revokedAt),
      ),
    )
    .orderBy(desc(schema.siteKey.createdAt));
  return rows.map(view);
}

/**
 * The settings every form submits. Validation errors name the field through
 * `AppError.message`, which the action maps to its own result codes.
 */
export interface SiteKeySettingsInput {
  name: string;
  /** One origin per line, as typed. */
  origins: string;
  dailyLimit?: unknown;
  welcome?: string | null;
  accent?: unknown;
}

interface SiteKeySettings {
  name: string;
  allowedOrigins: string[];
  dailyLimit: number;
  welcome: string | null;
  accent: string;
}

export type SiteKeyRefusal = 'name' | 'origins_empty' | 'origins_invalid' | 'origins_too_many' | 'daily_limit' | 'welcome' | 'accent';

/** Thrown for a bad field; the server action turns it into a form message. */
export class SiteKeyInvalid extends AppError {
  constructor(readonly field: SiteKeyRefusal) {
    super('invalid_request', `site key: ${field}`);
  }
}

/**
 * `current` is the row being edited: a field left blank keeps what the row
 * has, so clearing the limit box cannot quietly reset a key to the default.
 * On creation there is no row, and blank means the default.
 */
function settingsOf(
  input: SiteKeySettingsInput,
  current?: Pick<SiteKeySettings, 'dailyLimit' | 'accent'>,
): SiteKeySettings {
  const name = input.name.trim();
  if (name.length === 0 || name.length > 80) throw new SiteKeyInvalid('name');
  const origins = parseOrigins(input.origins);
  if (!origins.ok) {
    throw new SiteKeyInvalid(
      origins.reason === 'empty' ? 'origins_empty' : origins.reason === 'invalid' ? 'origins_invalid' : 'origins_too_many',
    );
  }
  const dailyLimit =
    input.dailyLimit === undefined || input.dailyLimit === null || input.dailyLimit === ''
      ? (current?.dailyLimit ?? SITE_KEY_DAILY_LIMIT_DEFAULT)
      : parseDailyLimit(input.dailyLimit);
  if (dailyLimit === null) throw new SiteKeyInvalid('daily_limit');
  const welcome = (input.welcome ?? '').trim();
  if (welcome.length > SITE_KEY_WELCOME_MAX) throw new SiteKeyInvalid('welcome');
  const accent =
    input.accent === undefined || input.accent === null || input.accent === ''
      ? (current?.accent ?? SITE_KEY_ACCENT_DEFAULT)
      : parseAccent(input.accent);
  if (accent === null) throw new SiteKeyInvalid('accent');
  return {
    name,
    allowedOrigins: origins.origins,
    dailyLimit,
    welcome: welcome.length > 0 ? welcome : null,
    accent,
  };
}

function mintKey(): string {
  return `${SITE_KEY_PREFIX}${randomHex(16)}`;
}

export interface CreateSiteKeyInput extends SiteKeySettingsInput {
  workspaceId: string;
  role: WorkspaceRole;
  libraryId: string;
}

export async function createSiteKey(input: CreateSiteKeyInput): Promise<SiteKeyView> {
  if (!canManageLibraries(input.role)) {
    throw new AppError('access_denied', 'only a library manager can create a site key');
  }
  await requireOwnedLibrary(input.workspaceId, input.libraryId);
  const settings = settingsOf(input);

  const [live] = await db()
    .select({ n: count() })
    .from(schema.siteKey)
    .where(and(eq(schema.siteKey.libraryId, input.libraryId), isNull(schema.siteKey.revokedAt)));
  if ((live?.n ?? 0) >= SITE_KEYS_PER_LIBRARY) {
    throw new AppError('api_key_limit_exceeded', 'this library already has its site keys');
  }

  const id = uuidv7();
  const createdAt = new Date();
  const key = mintKey();
  await db().insert(schema.siteKey).values({
    id,
    workspaceId: input.workspaceId,
    libraryId: input.libraryId,
    key,
    ...settings,
    createdAt,
  });
  return {
    id,
    key,
    ...settings,
    createdAt: createdAt.toISOString(),
    lastUsedAt: null,
  };
}

export interface UpdateSiteKeyInput extends SiteKeySettingsInput {
  workspaceId: string;
  role: WorkspaceRole;
  siteKeyId: string;
}

/** Edit the allowlist, limit and look; the key itself never changes. */
export async function updateSiteKey(input: UpdateSiteKeyInput): Promise<SiteKeyView> {
  if (!canManageLibraries(input.role)) {
    throw new AppError('access_denied', 'only a library manager can edit a site key');
  }
  const scope = and(
    eq(schema.siteKey.id, input.siteKeyId),
    eq(schema.siteKey.workspaceId, input.workspaceId),
    isNull(schema.siteKey.revokedAt),
  );
  const [current] = await db()
    .select({ dailyLimit: schema.siteKey.dailyLimit, accent: schema.siteKey.accent })
    .from(schema.siteKey)
    .where(scope)
    .limit(1);
  if (!current) throw new AppError('library_not_found', 'no such site key');
  const settings = settingsOf(input, current);
  const [row] = await db().update(schema.siteKey).set(settings).where(scope).returning();
  if (!row) throw new AppError('library_not_found', 'no such site key');
  return view(row);
}

/** Revocation is scoped: a workspace silences only its own keys. */
export async function revokeSiteKey(input: {
  workspaceId: string;
  role: WorkspaceRole;
  siteKeyId: string;
}): Promise<void> {
  if (!canManageLibraries(input.role)) {
    throw new AppError('access_denied', 'only a library manager can revoke a site key');
  }
  const revoked = await db()
    .update(schema.siteKey)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(schema.siteKey.id, input.siteKeyId),
        eq(schema.siteKey.workspaceId, input.workspaceId),
        isNull(schema.siteKey.revokedAt),
      ),
    )
    .returning({ id: schema.siteKey.id });
  if (revoked.length === 0) throw new AppError('library_not_found', 'no such site key');
}
