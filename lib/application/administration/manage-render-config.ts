/**
 * Console management of the rendering fallback: which service renders a page
 * a website build could not fetch itself, and the keys it is called with.
 * architecture.md 8.2, 15.3, requirement.md 5.3 (a change takes a reason and
 * lands in the audit chain).
 *
 * Two parts with two lifetimes. The provider in force is append-only like
 * `provider_model_config` -- what renders an installation's pages is part of
 * what its assets contain, and the table is the record of when it changed.
 * The keys are a mutable pool per provider: a build writes to it when a vendor
 * says a key is spent, and the console reorders, switches off and removes
 * keys; each console change is audited, never with the key itself.
 *
 * Stored keys are sent only to the vendor's own hosted API. A configuration
 * with a self-hosted base URL calls without authentication, so nobody with the
 * `models` capability can point the renderer at a host of their own and
 * receive somebody else's keys as Bearer headers (the same reasoning as
 * `mayCarryCredential` for the model registry).
 *
 * Nothing saved means the deployment's `RENDER_PROVIDER*` variables, which is
 * what an installation upgraded from before this table keeps running on.
 */
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { normalizeReason } from '@/lib/domain/admin';
import { uuidv7 } from '@/lib/domain/id';
import {
  isRenderProvider,
  normalizeRenderBaseUrl,
  RENDER_KEY_COOLDOWN_MS,
  RENDER_KEY_MAX_LENGTH,
  RENDER_KEYS_MAX,
  RENDER_PROVIDERS,
  type RenderKeyFailure,
  type RenderProviderName,
} from '@/lib/domain/render-config';
import {
  pageRendererFor,
  renderConfigFromEnvironment,
  type PageRenderer,
  type RenderConfig,
  type RenderKey,
} from '@/lib/infrastructure/connectors/render';
import {
  isCredentialKeyConfigured,
  openCredential,
  sealCredential,
} from '@/lib/infrastructure/crypto/credentials';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { recordAudit } from './audit';

type ConfigRow = typeof schema.renderConfig.$inferSelect;
type KeyRow = typeof schema.renderProviderKey.$inferSelect;

/** The provider in force as the console shows it. */
export interface RenderConfigRow {
  id: string;
  provider: RenderProviderName;
  baseUrl: string | null;
  enabled: boolean;
  createdAt: Date;
}

/** One key as the console shows it: never the key, nor a mask of it. */
export interface RenderKeyRow {
  id: string;
  provider: RenderProviderName;
  label: string;
  position: number;
  enabled: boolean;
  failure: RenderKeyFailure | null;
  failureDetail: string | null;
  failedAt: Date | null;
  /** Failed within the cooldown, so builds try it after the others. */
  coolingDown: boolean;
  createdAt: Date;
}

export interface RenderConfiguration {
  current: RenderConfigRow | null;
  /** What the deployment variables configure, shown when nothing is saved. */
  environment: { provider: RenderProviderName; selfHosted: boolean; keys: number } | null;
  /** Whether the configuration in force can render at all. */
  usable: boolean;
  /** Every provider's pool, in the order it is tried. */
  keys: Record<RenderProviderName, RenderKeyRow[]>;
  credentialKeyConfigured: boolean;
  /** Newest first. */
  history: RenderConfigRow[];
}

function shownConfig(row: ConfigRow): RenderConfigRow {
  return {
    id: row.id,
    provider: row.provider,
    baseUrl: row.baseUrl,
    enabled: row.enabled,
    createdAt: row.createdAt,
  };
}

function coolingDown(row: KeyRow, now: number): boolean {
  return row.failedAt !== null && now - row.failedAt.getTime() < RENDER_KEY_COOLDOWN_MS;
}

function shownKey(row: KeyRow, now: number): RenderKeyRow {
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    position: row.position,
    enabled: row.enabled,
    failure: row.failure ?? null,
    failureDetail: row.failureDetail,
    failedAt: row.failedAt,
    coolingDown: coolingDown(row, now),
    createdAt: row.createdAt,
  };
}

async function configInForce(): Promise<ConfigRow | null> {
  const [row] = await db()
    .select()
    .from(schema.renderConfig)
    .orderBy(desc(schema.renderConfig.createdAt))
    .limit(1);
  return row ?? null;
}

async function keysOf(provider: RenderProviderName): Promise<KeyRow[]> {
  return db()
    .select()
    .from(schema.renderProviderKey)
    .where(eq(schema.renderProviderKey.provider, provider))
    .orderBy(asc(schema.renderProviderKey.position), asc(schema.renderProviderKey.createdAt));
}

export async function readRenderConfiguration(): Promise<RenderConfiguration> {
  const [current, history, allKeys, resolved] = await Promise.all([
    configInForce(),
    db().select().from(schema.renderConfig).orderBy(desc(schema.renderConfig.createdAt)).limit(20),
    db()
      .select()
      .from(schema.renderProviderKey)
      .orderBy(asc(schema.renderProviderKey.position), asc(schema.renderProviderKey.createdAt)),
    resolveRenderConfig(),
  ]);
  const now = Date.now();
  const keys = Object.fromEntries(RENDER_PROVIDERS.map((name) => [name, [] as RenderKeyRow[]])) as Record<
    RenderProviderName,
    RenderKeyRow[]
  >;
  for (const row of allKeys) keys[row.provider].push(shownKey(row, now));
  const environment = current ? null : renderConfigFromEnvironment();
  return {
    current: current ? shownConfig(current) : null,
    environment: environment
      ? {
          provider: environment.provider,
          selfHosted: environment.baseUrl !== null,
          keys: environment.keys.length,
        }
      : null,
    usable: resolved !== null && pageRendererFor(resolved) !== null,
    keys,
    credentialKeyConfigured: isCredentialKeyConfigured(),
    history: history.map(shownConfig),
  };
}

/**
 * The keys a build calls with, opened, healthy ones first.
 *
 * A key that failed within the cooldown goes to the back rather than out: the
 * vendor does not say when a quota resets, so the build still tries it before
 * giving up, and its first answer clears the mark. A key whose cipher no
 * longer opens -- a rotated `CREDENTIAL_ENCRYPTION_KEY` -- is left out;
 * sending it would be a 401 on every page.
 */
async function usableKeys(
  provider: RenderProviderName,
): Promise<{ keys: RenderKey[]; marked: Set<string> }> {
  const now = Date.now();
  const rows = (await keysOf(provider)).filter((row) => row.enabled);
  const ordered = [
    ...rows.filter((row) => !coolingDown(row, now)),
    ...rows.filter((row) => coolingDown(row, now)),
  ];
  const opened = await Promise.all(
    ordered.map(async (row) => ({ id: row.id, apiKey: await openCredential(row.apiKeyCipher) })),
  );
  return {
    keys: opened.filter((key): key is RenderKey => key.apiKey !== null && key.apiKey.length > 0),
    marked: new Set(rows.filter((row) => row.failure !== null).map((row) => row.id)),
  };
}

/** Recorded against a key by a build or a probe, never by a console save. */
async function markKeyFailed(keyId: string, failure: RenderKeyFailure, detail: string): Promise<void> {
  await db()
    .update(schema.renderProviderKey)
    .set({ failure, failureDetail: detail.slice(0, 300), failedAt: new Date() })
    .where(eq(schema.renderProviderKey.id, keyId));
}

async function markKeyAnswered(keyId: string): Promise<void> {
  await db()
    .update(schema.renderProviderKey)
    .set({ failure: null, failureDetail: null, failedAt: null })
    .where(eq(schema.renderProviderKey.id, keyId));
}

/**
 * The configuration in force, keys opened, or null when the fallback is off.
 *
 * A saved row -- even one switched off -- is the console's decision and wins
 * over the deployment variables.
 */
async function resolveRenderConfig(): Promise<RenderConfig | null> {
  const row = await configInForce();
  if (!row) return renderConfigFromEnvironment();
  if (!row.enabled) return null;
  return consoleConfig(row.provider, row.baseUrl);
}

async function consoleConfig(
  provider: RenderProviderName,
  baseUrl: string | null,
): Promise<RenderConfig> {
  /* Keys go to the vendor's hosted API only; see the module comment. */
  if (baseUrl !== null) return { provider, baseUrl, keys: [] };
  const { keys, marked } = await usableKeys(provider);
  return {
    provider,
    baseUrl,
    keys,
    onKeyFailure: markKeyFailed,
    /* Written only for a key that carries a mark: one update per build at
       most per key, and none at all on a healthy pool. */
    onKeyAnswered: async (keyId) => {
      if (marked.delete(keyId)) await markKeyAnswered(keyId);
    },
  };
}

/**
 * The renderer a website build uses, resolved once per source so the keys it
 * set aside stay set aside for every page of that source. Null is the
 * documented degradation: a script shell fails as `source_unrendered`.
 */
export async function resolvePageRenderer(): Promise<PageRenderer | null> {
  const config = await resolveRenderConfig();
  return config ? pageRendererFor(config) : null;
}

export class RenderConfigRefused extends Error {
  constructor(
    readonly code:
      | 'invalid_provider'
      | 'invalid_base_url'
      | 'invalid_api_key'
      | 'too_many_keys'
      | 'unknown_key',
  ) {
    super(code);
    this.name = 'RenderConfigRefused';
  }
}

type Actor = { administratorId: string; email: string; clientAddress?: string | null };

export interface UpdateRenderConfigInput {
  actor: Actor;
  provider: string;
  /** Blank is the vendor's hosted API. */
  baseUrl: string;
  enabled: boolean;
  reason: string;
}

export async function updateRenderConfig(
  input: UpdateRenderConfigInput,
): Promise<{ configId: string }> {
  const reason = normalizeReason(input.reason);
  if (!isRenderProvider(input.provider)) throw new RenderConfigRefused('invalid_provider');
  const provider: RenderProviderName = input.provider;
  const typedBaseUrl = input.baseUrl.trim();
  const baseUrl = typedBaseUrl.length === 0 ? null : normalizeRenderBaseUrl(typedBaseUrl);
  if (typedBaseUrl.length > 0 && baseUrl === null) throw new RenderConfigRefused('invalid_base_url');

  const before = await configInForce();
  const written = { provider, baseUrl, enabled: input.enabled };
  const configId = uuidv7();
  await db().insert(schema.renderConfig).values({ id: configId, ...written });

  await recordAudit({
    administratorId: input.actor.administratorId,
    action: 'render_config.update',
    targetType: 'render_config',
    targetId: configId,
    reason,
    beforeValue: before
      ? { provider: before.provider, baseUrl: before.baseUrl, enabled: before.enabled }
      : null,
    afterValue: written,
    clientAddress: input.actor.clientAddress,
    result: 'success',
  });
  return { configId };
}

export interface UpdateRenderKeysInput {
  actor: Actor;
  provider: string;
  /**
   * The keys kept, in the order they are to be tried. A stored key missing
   * from this list is removed.
   */
  keep: { id: string; label: string; enabled: boolean; clearFailure: boolean }[];
  /** New keys, appended after the kept ones in the order given. */
  add: { label: string; apiKey: string }[];
  reason: string;
}

/**
 * The pool's one mutation: reorder, relabel, switch off, clear a failure mark,
 * remove and add, all in one save. One save rather than a verb per key
 * because the order is the point of the list, and the order is only ever
 * meaningful as a whole.
 */
export async function updateRenderKeys(input: UpdateRenderKeysInput): Promise<void> {
  const reason = normalizeReason(input.reason);
  if (!isRenderProvider(input.provider)) throw new RenderConfigRefused('invalid_provider');
  const provider: RenderProviderName = input.provider;

  const stored = await keysOf(provider);
  const storedIds = new Set(stored.map((row) => row.id));
  const keptIds = new Set<string>();
  for (const kept of input.keep) {
    if (!storedIds.has(kept.id) || keptIds.has(kept.id)) throw new RenderConfigRefused('unknown_key');
    keptIds.add(kept.id);
  }
  const added = input.add
    .map((entry) => ({ label: entry.label.trim().slice(0, 80), apiKey: entry.apiKey.trim() }))
    .filter((entry) => entry.apiKey.length > 0);
  for (const entry of added) {
    if (entry.apiKey.length > RENDER_KEY_MAX_LENGTH || /\s/.test(entry.apiKey)) {
      throw new RenderConfigRefused('invalid_api_key');
    }
  }
  if (input.keep.length + added.length > RENDER_KEYS_MAX) throw new RenderConfigRefused('too_many_keys');

  const removed = stored.filter((row) => !keptIds.has(row.id));
  const sealed = await Promise.all(added.map((entry) => sealCredential(entry.apiKey)));
  const fallbackLabel = (position: number) => `Key ${position + 1}`;

  await db().transaction(async (tx) => {
    if (removed.length > 0) {
      await tx.delete(schema.renderProviderKey).where(
        and(
          eq(schema.renderProviderKey.provider, provider),
          inArray(
            schema.renderProviderKey.id,
            removed.map((row) => row.id),
          ),
        ),
      );
    }
    for (const [position, kept] of input.keep.entries()) {
      await tx
        .update(schema.renderProviderKey)
        .set({
          position,
          label: kept.label.trim().slice(0, 80) || fallbackLabel(position),
          enabled: kept.enabled,
          ...(kept.clearFailure ? { failure: null, failureDetail: null, failedAt: null } : {}),
        })
        .where(eq(schema.renderProviderKey.id, kept.id));
    }
    if (added.length > 0) {
      await tx.insert(schema.renderProviderKey).values(
        added.map((entry, index) => {
          const position = input.keep.length + index;
          return {
            id: uuidv7(),
            provider,
            label: entry.label || fallbackLabel(position),
            apiKeyCipher: sealed[index]!,
            position,
          };
        }),
      );
    }
  });

  /* Labels and order, never a key: an added key is a count, a removed one a label. */
  const describe = (rows: { label: string; enabled: boolean }[]) =>
    rows.map((row) => ({ label: row.label, enabled: row.enabled }));
  await recordAudit({
    administratorId: input.actor.administratorId,
    action: 'render_keys.update',
    targetType: 'render_provider_key',
    targetId: provider,
    reason,
    beforeValue: { keys: describe(stored) },
    afterValue: {
      keys: describe(input.keep),
      added: added.length,
      removed: removed.map((row) => row.label),
      cleared: input.keep.filter((row) => row.clearFailure).length,
    },
    clientAddress: input.actor.clientAddress,
    result: 'success',
  });
}

export interface RenderProbeResult {
  ok: boolean;
  latencyMs: number;
  /** The page's title and size. Null on failure. */
  detail: string | null;
  error: string | null;
}

export const RENDER_PROBE_URL = 'https://example.com/';

/**
 * One render through a configuration as typed, saved or not, with the stored
 * keys of that provider -- for the vendor's hosted API only, as in a build. A
 * key the vendor calls spent or refused here is marked just as a build would
 * mark it: the probe is the cheapest way to find out.
 */
export async function probeRenderConfig(input: {
  provider: string;
  baseUrl: string;
  target?: string;
}): Promise<RenderProbeResult | { refused: 'invalid_provider' | 'invalid_base_url' | 'no_key' }> {
  if (!isRenderProvider(input.provider)) return { refused: 'invalid_provider' };
  const typedBaseUrl = input.baseUrl.trim();
  const baseUrl = typedBaseUrl.length === 0 ? null : normalizeRenderBaseUrl(typedBaseUrl);
  if (typedBaseUrl.length > 0 && baseUrl === null) return { refused: 'invalid_base_url' };
  const config = await consoleConfig(input.provider, baseUrl);
  const renderer = pageRendererFor(config);
  if (!renderer) return { refused: 'no_key' };

  const startedAt = Date.now();
  try {
    const page = await renderer.render(new URL(input.target ?? RENDER_PROBE_URL));
    const title = page.title ? `${page.title} · ` : '';
    return {
      ok: true,
      latencyMs: Date.now() - startedAt,
      detail: `${title}${page.bytes} B ${page.contentType}`,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      detail: null,
      error: error instanceof Error ? error.message : 'request failed',
    };
  }
}
