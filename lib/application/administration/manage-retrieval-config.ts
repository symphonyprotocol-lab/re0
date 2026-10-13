/**
 * Console management of retrieval's tunables. architecture.md 9.2, 9.6,
 * requirement.md 5.3 (a change takes a reason and lands in the audit chain).
 *
 * The configuration is the newest `retrieval_config` row, or the domain
 * defaults when there is none. It is read on the request path -- one indexed
 * query per retrieval -- so a save is in force on the very next request, with
 * no cache to warm or process to restart. The public result cache keys on the
 * row's id (query-docs), so it retires itself the same way.
 */
import { desc } from 'drizzle-orm';
import { normalizeReason } from '@/lib/domain/admin';
import { uuidv7 } from '@/lib/domain/id';
import {
  DEFAULT_RETRIEVAL_SETTINGS,
  RETRIEVAL_SETTING_KEYS,
  validateRetrievalSettings,
  type RetrievalSettingKey,
  type RetrievalSettings,
} from '@/lib/domain/retrieval-config';
import { modelProviderStatus } from './manage-model-config';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { recordAudit } from './audit';

/**
 * Which retrieval models this installation has configured.
 *
 * The console tunes the rerank window, but reranking only runs when a rerank
 * model is saved and switched on -- and a window tuned for a reranker that is
 * not there does nothing. The page says which it is, and now says where to go
 * and fix it, since both models are configuration the console itself owns.
 */
export interface RetrievalProviderStatus {
  embeddings: boolean;
  rerank: boolean;
}

export async function retrievalProviderStatus(): Promise<RetrievalProviderStatus> {
  const status = await modelProviderStatus();
  return { embeddings: status.embedding, rerank: status.rerank };
}

export interface ActiveRetrievalSettings extends RetrievalSettings {
  /** Null when the defaults are in force because nothing was ever saved. */
  configId: string | null;
  createdAt: Date | null;
}

export interface RetrievalConfigRow extends RetrievalSettings {
  id: string;
  createdAt: Date;
}

export interface RetrievalConfiguration {
  current: ActiveRetrievalSettings;
  history: RetrievalConfigRow[];
}

function settingsOf(row: Record<RetrievalSettingKey, number>): RetrievalSettings {
  return Object.fromEntries(
    RETRIEVAL_SETTING_KEYS.map((key) => [key, row[key]]),
  ) as RetrievalSettings;
}

/**
 * The configuration in force.
 *
 * A read failure falls back to the defaults, logged: retrieval is the product,
 * and a settings table that is briefly unreachable must degrade to the
 * constants the code shipped with rather than take every request down.
 */
export async function activeRetrievalSettings(): Promise<ActiveRetrievalSettings> {
  let row: RetrievalConfigRow | undefined;
  try {
    [row] = await db()
      .select()
      .from(schema.retrievalConfig)
      .orderBy(desc(schema.retrievalConfig.createdAt))
      .limit(1);
  } catch (error) {
    console.error(
      `retrieval config unreadable, using defaults: ${error instanceof Error ? error.message : 'unknown'}`,
    );
  }
  if (!row) return { ...DEFAULT_RETRIEVAL_SETTINGS, configId: null, createdAt: null };
  return { ...settingsOf(row), configId: row.id, createdAt: row.createdAt };
}

export async function readRetrievalConfiguration(): Promise<RetrievalConfiguration> {
  const history = await db()
    .select()
    .from(schema.retrievalConfig)
    .orderBy(desc(schema.retrievalConfig.createdAt))
    .limit(40);
  const newest = history[0];
  return {
    current: newest
      ? { ...settingsOf(newest), configId: newest.id, createdAt: newest.createdAt }
      : { ...DEFAULT_RETRIEVAL_SETTINGS, configId: null, createdAt: null },
    history,
  };
}

export interface UpdateRetrievalConfigInput {
  actor: { administratorId: string; email: string; clientAddress?: string | null };
  /** Every key; a missing one is refused, never defaulted. */
  values: Partial<Record<RetrievalSettingKey, number>>;
  reason: string;
}

/** Throws `RetrievalConfigRefused` (domain) or `AdminChangeRefused` for a missing reason. */
export async function updateRetrievalConfig(
  input: UpdateRetrievalConfigInput,
): Promise<{ configId: string }> {
  const reason = normalizeReason(input.reason);
  const settings = validateRetrievalSettings(input.values);
  const before = await activeRetrievalSettings();

  const configId = uuidv7();
  await db().insert(schema.retrievalConfig).values({ id: configId, ...settings });

  await recordAudit({
    administratorId: input.actor.administratorId,
    action: 'retrieval_config.update',
    targetType: 'retrieval_config',
    targetId: configId,
    reason,
    /* The defaults are the "before" of a first save too; an auditor should
       see what the numbers were, not that there was no row. */
    beforeValue: settingsOf(before),
    afterValue: settings,
    clientAddress: input.actor.clientAddress,
    result: 'success',
  });

  return { configId };
}
