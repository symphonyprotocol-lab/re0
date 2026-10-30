/**
 * Use cases: connect a Notion account for page imports, list what it may
 * import, prove a chosen page is readable at submit time, and hand the
 * grant to ingestion for the asset's builds.
 *
 * The GitHub connection (github-connection.ts) keeps its token only to prove
 * whose repositories are on offer. Notion's is kept for more: a Notion page
 * is unreadable without it, at creation and at every refresh after, so the
 * source row remembers which account it was imported under
 * (lib/domain/notion.ts, `NOTION_SOURCE_USER_KEY`) and the build resolves the
 * grant from there. Sealed at rest in its own table, gone the moment the
 * person disconnects or Notion reports the token revoked -- and an asset
 * whose grant is gone fails its next build with `source_forbidden` instead
 * of quietly reading with someone else's credential.
 */
import { eq } from 'drizzle-orm';
import { AppError } from '@/contracts/errors';
import { AuthFailure, OAUTH_STATE_TTL_MS, safeReturnTo } from '@/lib/domain/auth';
import {
  isNotionConnectHandshake,
  notionPageId,
  type NotionConnectHandshake,
  type NotionConnectOutcome,
  type NotionImportRefusal,
  type PageFacts,
} from '@/lib/domain/notion';
import { uuidv7 } from '@/lib/domain/id';
import { seal, unseal } from '@/lib/infrastructure/crypto/sealed';
import { randomToken, timingSafeEqual } from '@/lib/infrastructure/crypto/tokens';
import {
  connectAuthorizeUrl,
  exchangeForPageGrant,
  listAccessiblePages,
  NotionGrantRevoked,
  readPage,
  type PageGrant,
} from '@/lib/infrastructure/identity/notion';
import { db, schema } from '@/lib/infrastructure/postgres/client';

export type { PageFacts as NotionPage };

/** Seam for tests; production always talks to Notion. */
export interface NotionPageReader {
  listAccessiblePages(token: string): Promise<PageFacts[]>;
  readPage(token: string, pageId: string): Promise<PageFacts | null>;
}

const notionReader: NotionPageReader = { listAccessiblePages, readPage };

/* ------------------------------------------------------------- connecting */

export interface BeginNotionConnectInput {
  returnTo: unknown;
  /** `${APP_BASE_URL}/api/auth/notion/callback/connect`, built by the caller. */
  redirectUri: string;
  now?: Date;
}

export interface BeginNotionConnectResult {
  redirectUrl: string;
  /** Sealed handshake, to be written as a short-lived cookie. */
  handshake: string;
  expiresAt: number;
}

export async function beginNotionConnect(
  input: BeginNotionConnectInput,
): Promise<BeginNotionConnectResult> {
  const now = input.now ?? new Date();
  const handshake: NotionConnectHandshake = {
    purpose: 'notion_connect',
    state: randomToken(),
    returnTo: safeReturnTo(input.returnTo),
    expiresAt: now.getTime() + OAUTH_STATE_TTL_MS,
  };
  return {
    redirectUrl: connectAuthorizeUrl({ state: handshake.state, redirectUri: input.redirectUri }),
    handshake: await seal(handshake),
    expiresAt: handshake.expiresAt,
  };
}

export interface CompleteNotionConnectInput {
  /** The signed-in account the grant is stored under. */
  userId: string;
  code: string | null;
  state: string | null;
  sealedHandshake: string | null | undefined;
  redirectUri: string;
  now?: Date;
  /** Seam for tests; production always exchanges with Notion. */
  exchange?: (input: { code: string; redirectUri: string }) => Promise<PageGrant>;
}

export interface CompleteNotionConnectResult {
  workspaceName: string | null;
  returnTo: string;
}

/**
 * Verifies the handshake, exchanges the code and stores the sealed grant.
 * A second connection for the same account replaces the first, so a
 * revoked-and-reconnected account has exactly one live credential on file.
 */
export async function completeNotionConnect(
  input: CompleteNotionConnectInput,
): Promise<CompleteNotionConnectResult> {
  const now = input.now ?? new Date();
  const handshake = await unseal<unknown>(input.sealedHandshake);
  if (!isNotionConnectHandshake(handshake)) {
    throw new AuthFailure('oauth_failed', 'missing or unreadable connect handshake');
  }
  if (handshake.expiresAt <= now.getTime()) {
    throw new AuthFailure('oauth_failed', 'connect handshake expired');
  }
  if (!input.state || !timingSafeEqual(handshake.state, input.state)) {
    throw new AuthFailure('oauth_failed', 'connect state mismatch');
  }
  if (!input.code) {
    throw new AuthFailure('oauth_failed', 'connect callback carried no code');
  }

  const exchange = input.exchange ?? exchangeForPageGrant;
  const grant = await exchange({ code: input.code, redirectUri: input.redirectUri });
  const tokenSealed = await seal(grant.accessToken);

  await db()
    .insert(schema.notionConnection)
    .values({
      id: uuidv7(now.getTime()),
      userId: input.userId,
      botId: grant.botId,
      notionWorkspaceId: grant.workspaceId,
      workspaceName: grant.workspaceName,
      notionUserId: grant.notionUserId,
      ownerName: grant.ownerName,
      tokenSealed,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.notionConnection.userId,
      set: {
        botId: grant.botId,
        notionWorkspaceId: grant.workspaceId,
        workspaceName: grant.workspaceName,
        notionUserId: grant.notionUserId,
        ownerName: grant.ownerName,
        tokenSealed,
        updatedAt: now,
      },
    });

  return { workspaceName: grant.workspaceName, returnTo: handshake.returnTo };
}

/** The return path with the outcome on it, for the wizard to read. */
export function notionConnectReturnPath(returnTo: string, outcome: NotionConnectOutcome): string {
  const url = new URL(safeReturnTo(returnTo), 'http://placeholder.invalid');
  url.searchParams.set('notion', outcome);
  return `${url.pathname}${url.search}`;
}

export async function disconnectNotion(userId: string): Promise<void> {
  await db().delete(schema.notionConnection).where(eq(schema.notionConnection.userId, userId));
}

/* ---------------------------------------------------------------- reading */

export interface NotionConnectionView {
  workspaceName: string | null;
  ownerName: string | null;
  connectedAt: Date;
}

/** The connection without its token: what a page may show. */
export async function notionConnectionFor(userId: string): Promise<NotionConnectionView | null> {
  const [row] = await db()
    .select({
      workspaceName: schema.notionConnection.workspaceName,
      ownerName: schema.notionConnection.ownerName,
      connectedAt: schema.notionConnection.updatedAt,
    })
    .from(schema.notionConnection)
    .where(eq(schema.notionConnection.userId, userId))
    .limit(1);
  return row ?? null;
}

interface Grant {
  token: string;
  workspaceName: string | null;
  ownerName: string | null;
}

async function grantFor(userId: string): Promise<Grant | null> {
  const [row] = await db()
    .select({
      tokenSealed: schema.notionConnection.tokenSealed,
      workspaceName: schema.notionConnection.workspaceName,
      ownerName: schema.notionConnection.ownerName,
    })
    .from(schema.notionConnection)
    .where(eq(schema.notionConnection.userId, userId))
    .limit(1);
  if (!row) return null;
  const token = await unseal<string>(row.tokenSealed);
  /* Unreadable means the signing secret rotated; the grant is as good as gone. */
  if (typeof token !== 'string') {
    await disconnectNotion(userId);
    return null;
  }
  return { token, workspaceName: row.workspaceName, ownerName: row.ownerName };
}

/**
 * The plaintext token for a build. Ingestion only: the connector needs it
 * on every request, and there is no way to read a page without it. Null
 * when the person never connected or has since disconnected.
 */
export async function notionTokenFor(userId: string): Promise<string | null> {
  return (await grantFor(userId))?.token ?? null;
}

export type ImportablePages =
  | { connected: false }
  | { connected: true; workspaceName: string | null; ownerName: string | null; pages: PageFacts[] };

/**
 * What the wizard offers: every page the grant can read, newest edit first.
 * A token Notion no longer honours drops the connection, so the wizard asks
 * for a fresh one instead of showing a list that submit would then refuse.
 */
export async function listImportablePages(
  userId: string,
  reader: NotionPageReader = notionReader,
): Promise<ImportablePages> {
  const grant = await grantFor(userId);
  if (!grant) return { connected: false };
  try {
    const pages = await reader.listAccessiblePages(grant.token);
    return {
      connected: true,
      workspaceName: grant.workspaceName,
      ownerName: grant.ownerName,
      pages,
    };
  } catch (error) {
    if (error instanceof NotionGrantRevoked) {
      await disconnectNotion(userId);
      return { connected: false };
    }
    throw error;
  }
}

/* ------------------------------------------------------------ submitting */

export type NotionImportRefusalCode = NotionImportRefusal;

/**
 * A page the account may not import. Carries the refusal so the wizard can
 * say which rule was hit; the `reason` on the base class keeps the public
 * contract's vocabulary for REST callers.
 */
export class NotionImportRefused extends AppError {
  constructor(readonly refusal: NotionImportRefusalCode) {
    super(
      'claim_verification_failed',
      `notion import refused: ${refusal}`,
      refusal === 'not_connected' ? 'account_not_linked' : 'source_mismatch',
    );
    this.name = 'NotionImportRefused';
  }
}

export interface NotionImportCheck {
  /** The page's own URL as Notion spells it, which the source location is set to. */
  location: string;
  pageId: string;
  title: string;
}

export type CheckNotionImport = (input: {
  userId: string;
  location: string;
}) => Promise<NotionImportCheck>;

/**
 * Re-reads the chosen page with the account's own token. The list the
 * wizard showed is not trusted: a form post can name any page, and the only
 * pages that answer are the ones this grant was given.
 */
export async function checkNotionImport(
  input: { userId: string; location: string },
  reader: NotionPageReader = notionReader,
): Promise<NotionImportCheck> {
  const grant = await grantFor(input.userId);
  if (!grant) throw new NotionImportRefused('not_connected');

  const pageId = notionPageId(input.location);
  if (!pageId) throw new NotionImportRefused('not_found');

  let page: PageFacts | null;
  try {
    page = await reader.readPage(grant.token, pageId);
  } catch (error) {
    if (error instanceof NotionGrantRevoked) {
      await disconnectNotion(input.userId);
      throw new NotionImportRefused('not_connected');
    }
    throw error;
  }
  if (!page || page.archived) throw new NotionImportRefused('not_found');
  return { location: page.url, pageId: page.id, title: page.title };
}
