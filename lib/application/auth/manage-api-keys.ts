/**
 * A workspace's API keys. architecture.md 5.1: the server keeps hash, prefix
 * and last four -- the full key exists once, in the creation response, and is
 * never reconstructable. Creation counts against the plan's key limit;
 * revocation is a timestamp, not a delete, so the row keeps explaining
 * historical usage. Rotation is the two in one transaction: a replacement
 * with the same name, environment and scopes, and the old key silenced.
 */
import { and, count, desc, eq, isNull } from 'drizzle-orm';
import { AppError } from '@/contracts/errors';
import {
  apiKeyPrefix,
  isApiKeyEnvironment,
  maskApiKey,
  normaliseScopes,
  parseScopes,
  type ApiKeyEnvironment,
} from '@/lib/domain/api-key';
import { uuidv7 } from '@/lib/domain/id';
import { randomHex } from '@/lib/infrastructure/crypto/tokens';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { IN_FORCE_FIRST, subscriptionInForce } from '@/lib/application/plans/in-force';
import { PLAN_VERSION_NEWEST_FIRST } from '@/lib/application/plans/configuration';
import { hashApiKey } from './api-key';
import { canManageApiKeys, type WorkspaceRole } from '@/lib/application/libraries';

export interface ApiKeyView {
  id: string;
  name: string;
  masked: string;
  environment: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
}

export async function listApiKeys(workspaceId: string): Promise<ApiKeyView[]> {
  const rows = await db()
    .select()
    .from(schema.apiKey)
    .where(and(eq(schema.apiKey.workspaceId, workspaceId), isNull(schema.apiKey.revokedAt)))
    .orderBy(desc(schema.apiKey.createdAt));

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    masked: maskApiKey(row.keyPrefix, row.lastFour),
    environment: row.environment,
    scopes: normaliseScopes(row.scopes),
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  }));
}

export interface CreateApiKeyInput {
  workspaceId: string;
  role: WorkspaceRole;
  name: string;
  /** Defaults to `live`. */
  environment?: unknown;
  /** Defaults to the three read scopes, the way pre-scope keys behaved; `assets:write` is only ever asked for. */
  scopes?: unknown;
}

/**
 * Mint a key. The plaintext is returned exactly once; what the table keeps
 * cannot produce it again.
 */
export async function createApiKey(input: CreateApiKeyInput): Promise<{ key: string; view: ApiKeyView }> {
  /* requirement.md 3.3: keys are the owner's. A developer may use one; minting
     and revoking are not theirs to do, and a server action is a public
     endpoint whatever the page chooses to render. */
  if (!canManageApiKeys(input.role)) {
    throw new AppError('access_denied', 'only the workspace owner can create an API key');
  }

  const name = input.name.trim();
  if (name.length === 0 || name.length > 80) {
    throw new AppError('invalid_request', 'a key needs a name (1-80 characters)');
  }
  const environment = input.environment ?? 'live';
  if (!isApiKeyEnvironment(environment)) {
    throw new AppError('invalid_request', 'environment must be live or test');
  }
  const scopes = input.scopes === undefined ? normaliseScopes(['retrieval']) : parseScopes(input.scopes);
  if (!scopes) {
    throw new AppError('invalid_request', 'choose at least one grantable scope');
  }

  const database = db();
  const [active] = await database
    .select({ n: count() })
    .from(schema.apiKey)
    .where(and(eq(schema.apiKey.workspaceId, input.workspaceId), isNull(schema.apiKey.revokedAt)));
  if ((active?.n ?? 0) >= await apiKeyLimit(input.workspaceId)) {
    throw new AppError('api_key_limit_exceeded', 'the plan’s key limit is reached');
  }

  const minted = await mint(environment);
  const id = uuidv7();
  const createdAt = new Date();
  await database.insert(schema.apiKey).values({
    id,
    workspaceId: input.workspaceId,
    name,
    keyHash: minted.hash,
    keyPrefix: minted.prefix,
    lastFour: minted.lastFour,
    scopes,
    environment,
    createdAt,
  });

  return {
    key: minted.key,
    view: {
      id,
      name,
      masked: maskApiKey(minted.prefix, minted.lastFour),
      environment,
      scopes,
      createdAt: createdAt.toISOString(),
      lastUsedAt: null,
    },
  };
}

/**
 * Replace a key. The new one carries the old one's name, environment and
 * scopes; the old one is revoked in the same transaction, so there is no
 * moment with two live keys (the plan's limit is untouched) and none with
 * zero. `null` when the key is not this workspace's live key -- indistinct
 * from "does not exist", as revocation is.
 */
export async function rotateApiKey(input: {
  workspaceId: string;
  role: WorkspaceRole;
  keyId: string;
}): Promise<{ key: string; view: ApiKeyView; replaced: string } | null> {
  if (!canManageApiKeys(input.role)) {
    throw new AppError('access_denied', 'only the workspace owner can rotate an API key');
  }

  return db().transaction(async (tx) => {
    const [old] = await tx
      .select()
      .from(schema.apiKey)
      .where(
        and(
          eq(schema.apiKey.id, input.keyId),
          eq(schema.apiKey.workspaceId, input.workspaceId),
          isNull(schema.apiKey.revokedAt),
        ),
      )
      .for('update');
    if (!old) return null;

    const environment: ApiKeyEnvironment = isApiKeyEnvironment(old.environment)
      ? old.environment
      : 'live';
    const scopes = normaliseScopes(old.scopes);
    const minted = await mint(environment);
    const id = uuidv7();
    const createdAt = new Date();

    await tx.insert(schema.apiKey).values({
      id,
      workspaceId: input.workspaceId,
      name: old.name,
      keyHash: minted.hash,
      keyPrefix: minted.prefix,
      lastFour: minted.lastFour,
      scopes,
      environment,
      createdAt,
    });
    await tx
      .update(schema.apiKey)
      .set({ revokedAt: createdAt })
      .where(eq(schema.apiKey.id, old.id));

    return {
      key: minted.key,
      replaced: old.id,
      view: {
        id,
        name: old.name,
        masked: maskApiKey(minted.prefix, minted.lastFour),
        environment,
        scopes,
        createdAt: createdAt.toISOString(),
        lastUsedAt: null,
      },
    };
  });
}

/** Revocation is scoped: a workspace can only silence its own keys. */
export async function revokeApiKey(input: {
  workspaceId: string;
  role: WorkspaceRole;
  keyId: string;
}): Promise<void> {
  if (!canManageApiKeys(input.role)) {
    throw new AppError('access_denied', 'only the workspace owner can revoke an API key');
  }

  await db()
    .update(schema.apiKey)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(schema.apiKey.id, input.keyId),
        eq(schema.apiKey.workspaceId, input.workspaceId),
        isNull(schema.apiKey.revokedAt),
      ),
    );
}

/** 192 bits from the platform CSPRNG behind a prefix that names the environment. */
async function mint(environment: ApiKeyEnvironment): Promise<{
  key: string;
  hash: string;
  prefix: string;
  lastFour: string;
}> {
  const secret = randomHex(24);
  const prefix = apiKeyPrefix(environment);
  const key = `${prefix}${secret}`;
  return { key, hash: await hashApiKey(key), prefix, lastFour: key.slice(-4) };
}

/** The plan's key ceiling: the active subscription's version, or newest Free. */
async function apiKeyLimit(workspaceId: string): Promise<number> {
  const database = db();
  const [active] = await database
    .select({ limit: schema.planVersion.apiKeyLimit })
    .from(schema.subscription)
    .innerJoin(schema.planVersion, eq(schema.planVersion.id, schema.subscription.planVersionId))
    .where(
      and(eq(schema.subscription.workspaceId, workspaceId), subscriptionInForce()),
    )
    .orderBy(...IN_FORCE_FIRST)
    .limit(1);
  if (active) return active.limit;

  const [free] = await database
    .select({ limit: schema.planVersion.apiKeyLimit })
    .from(schema.planVersion)
    .where(eq(schema.planVersion.planId, 'free'))
    /* The id tiebreak, as every other plan-version reader uses. */
    .orderBy(...PLAN_VERSION_NEWEST_FIRST)
    .limit(1);
  return free?.limit ?? 1;
}
