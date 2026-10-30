/**
 * Console management of the channel-commerce settings (agent-first-proposal.md
 * 6.9, 13.2; requirement.md 5.3: a change takes a reason and lands in the
 * audit chain).
 *
 * The settings in force are the newest `commerce_config` row, or the domain
 * defaults when there is none -- the same shape as the retrieval settings.
 * They are read where they are applied: plan creation and checkout read the
 * minimum and the fee, the hold and the threshold are read by the redeem and
 * payout paths, so a save is in force on the next request.
 */
import { desc } from 'drizzle-orm';
import { normalizeReason } from '@/lib/domain/admin';
import {
  COMMERCE_SETTING_KEYS,
  DEFAULT_COMMERCE_SETTINGS,
  validateCommerceSettings,
  type CommerceSettingKey,
  type CommerceSettings,
} from '@/lib/domain/commerce-config';
import { uuidv7 } from '@/lib/domain/id';
import { db, schema, type Database } from '@/lib/infrastructure/postgres/client';
import type { Tx } from '@/lib/application/plans/quota';
import { recordAudit } from './audit';

export interface ActiveCommerceSettings extends CommerceSettings {
  /** Null when the defaults are in force because nothing was ever saved. */
  configId: string | null;
  createdAt: Date | null;
}

function settingsOf(row: Record<CommerceSettingKey, number>): CommerceSettings {
  return Object.fromEntries(COMMERCE_SETTING_KEYS.map((key) => [key, row[key]])) as CommerceSettings;
}

/**
 * The settings in force. Unlike retrieval, a read failure is not papered
 * over with the defaults: these decide what a buyer is charged and when a
 * creator is paid, and a guess is worse than an error.
 */
export async function activeCommerceSettings(executor: Tx | Database = db()): Promise<ActiveCommerceSettings> {
  const [row] = await executor
    .select()
    .from(schema.commerceConfig)
    .orderBy(desc(schema.commerceConfig.createdAt), desc(schema.commerceConfig.id))
    .limit(1);
  if (!row) return { ...DEFAULT_COMMERCE_SETTINGS, configId: null, createdAt: null };
  return { ...settingsOf(row), configId: row.id, createdAt: row.createdAt };
}

export async function readCommerceConfiguration(): Promise<{
  current: ActiveCommerceSettings;
  history: (CommerceSettings & { id: string; createdAt: Date })[];
}> {
  const history = await db()
    .select()
    .from(schema.commerceConfig)
    .orderBy(desc(schema.commerceConfig.createdAt), desc(schema.commerceConfig.id))
    .limit(40);
  const newest = history[0];
  return {
    current: newest
      ? { ...settingsOf(newest), configId: newest.id, createdAt: newest.createdAt }
      : { ...DEFAULT_COMMERCE_SETTINGS, configId: null, createdAt: null },
    history,
  };
}

/** Throws `CommerceConfigRefused` (domain) or `AdminChangeRefused` for a missing reason. */
export async function updateCommerceConfig(input: {
  actor: { administratorId: string; email: string; clientAddress?: string | null };
  values: Partial<Record<CommerceSettingKey, number>>;
  reason: string;
}): Promise<{ configId: string }> {
  const reason = normalizeReason(input.reason);
  const settings = validateCommerceSettings(input.values);
  const before = await activeCommerceSettings();

  const configId = uuidv7();
  await db().insert(schema.commerceConfig).values({ id: configId, ...settings });

  await recordAudit({
    administratorId: input.actor.administratorId,
    action: 'commerce_config.update',
    targetType: 'commerce_config',
    targetId: configId,
    reason,
    beforeValue: settingsOf(before),
    afterValue: settings,
    clientAddress: input.actor.clientAddress,
    result: 'success',
  });
  return { configId };
}
