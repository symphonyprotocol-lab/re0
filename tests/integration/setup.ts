/**
 * Shared set-up for the integration files: the database under test, the
 * secrets, and model endpoints pointed at a local fake. Import it first.
 */
import { beforeAll, vi } from 'vitest';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

process.env.DATABASE_URL = TEST_DATABASE_URL ?? 'postgres://unused';
process.env.AUTH_SECRET ??= 'test-auth-secret-that-is-long-enough-0000';
process.env.ADMIN_SECRET_KEY ??= 'test-admin-secret-key-that-is-long-enough';
delete process.env.DATABASE_WS_PROXY;

export function pointModelsAt(baseUrl: string): void {
  process.env.GENERATION_BASE_URL = baseUrl;
  process.env.GENERATION_API_KEY = 'test-key';
  process.env.GENERATION_MODEL = 'fake-gen-1';
  /* The fake takes image parts (posts with images need every generation entry to). */
  process.env.GENERATION_SUPPORTS_IMAGES = 'true';
  process.env.EMBEDDING_BASE_URL = baseUrl;
  process.env.EMBEDDING_API_KEY = 'test-key';
  process.env.EMBEDDING_MODEL = 'fake-embed';
  process.env.TRANSCRIPTION_BASE_URL = baseUrl;
  process.env.TRANSCRIPTION_API_KEY = 'test-key';
  process.env.TRANSCRIPTION_MODEL = 'fake-whisper';
  process.env.PROVIDER_COST_RATES = JSON.stringify([
    ...['fake-embed', 'fake-embed-2', 'fake-embed-3'].map((model) => ({ service: 'embedding', endpoint: baseUrl, model, unit: 'tokens', usdPerUnit: '0.00000002', source: 'Integration fixture: $0.02/M tokens' })),
    { service: 'generation', endpoint: baseUrl, model: 'fake-gen-1', unit: 'tokens', usdPerUnit: '0.000001', outputUsdPerUnit: '0.000004', source: 'Integration fixture: $1 / $4 per M tokens' },
    { service: 'transcription', endpoint: baseUrl, model: 'fake-whisper', unit: 'seconds', usdPerUnit: '0.0001', source: 'Integration fixture: $0.006/minute' },
    { service: 'firecrawl', endpoint: 'https://api.firecrawl.dev', model: 'parse', unit: 'firecrawl_credits', usdPerUnit: '0.001', source: 'Integration fixture: $1/1000 credits' },
  ]);
}

let counter = 0;
/* Per test process: with `Date` frozen (freezeDateAtWindowStart), the time alone repeats across runs against one database. */
const PROCESS_TAG = Math.random().toString(36).slice(2, 6);
export function uniqueName(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}${PROCESS_TAG}-${counter}`;
}

/**
 * Stops the clock -- `Date` only, so timers, the database driver and the
 * fake servers keep real time -- at the start of the next whole window of
 * `windowSeconds`. Rate limits count hits in fixed windows on the wall
 * clock (lib/services/rate-limit.ts): a test filling a window and then
 * expecting a 429 would otherwise get a 201 whenever a window boundary fell
 * inside it. Undo with `vi.useRealTimers()`.
 */
export function freezeDateAtWindowStart(windowSeconds = 60): Date {
  const windowMs = windowSeconds * 1_000;
  const at = new Date((Math.floor(Date.now() / windowMs) + 1) * windowMs);
  vi.useFakeTimers({ toFake: ['Date'], now: at });
  return at;
}

/**
 * Runs a migration's hand-written backfill again -- the SQL between
 * `-- <name> begin` and `-- <name> end` -- so a test can freeze what it seeded
 * in the conversation tables, as the release did: `legacy-stats` (0066,
 * `ree_legacy_stats` / `user_legacy_stats`), `api-key-usage` and
 * `chats-removal-notice` (0067). Each overwrites or skips what it wrote, so
 * they may run any number of times.
 */
export async function runBackfill(name: 'legacy-stats' | 'api-key-usage' | 'chats-removal-notice'): Promise<void> {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { db } = await import('@/lib/infra/db');
  const { sql } = await import('drizzle-orm');
  const dir = new URL('../../db/migrations/', import.meta.url);
  for (const file of readdirSync(dir).filter((entry) => entry.endsWith('.sql'))) {
    const text = readFileSync(new URL(file, dir), 'utf8');
    const begin = text.indexOf(`-- ${name} backfill begin`);
    if (begin < 0) continue;
    const end = text.indexOf(`-- ${name} backfill end`, begin);
    for (const statement of text.slice(begin, end).split('--> statement-breakpoint')) {
      if (statement.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '').trim()) await db().execute(sql.raw(statement));
    }
    return;
  }
  throw new Error(`no backfill named ${name}`);
}

/** A migration file's statements, as the deploy runs them: split on `--> statement-breakpoint`, comment-only pieces left out. */
async function statementsOf(url: URL): Promise<string[]> {
  const { readFileSync } = await import('node:fs');
  return readFileSync(url, 'utf8')
    .split('--> statement-breakpoint')
    .filter((statement) => statement.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '').trim());
}

async function conversationTablesExist(): Promise<boolean> {
  const { db } = await import('@/lib/infra/db');
  const { sql } = await import('drizzle-orm');
  const result = await db().execute<{ present: boolean }>(sql`select to_regclass('public.conversation') is not null as present`);
  return result.rows[0]!.present;
}

/**
 * The conversation tables, and the columns that pointed at them, back as
 * they were before migration 0070 dropped them (tests/fixtures/
 * pre-0070-conversations.sql), so a test can seed old conversations. Empty;
 * a no-op while they exist. `dropConversationTables` puts the database back.
 */
export async function restoreConversationTables(): Promise<void> {
  if (await conversationTablesExist()) return;
  const { db } = await import('@/lib/infra/db');
  const { sql } = await import('drizzle-orm');
  for (const statement of await statementsOf(new URL('../fixtures/pre-0070-conversations.sql', import.meta.url))) await db().execute(sql.raw(statement));
}

/** Migration 0070's statements in order, its own table's creation left out once that table exists (as it does after the suite's migrations). */
export async function migration0070(): Promise<string[]> {
  return (await statementsOf(new URL('../../db/migrations/0070_drop_conversations.sql', import.meta.url))).filter((statement) => !/create table "payout_trace_legacy"/i.test(statement));
}

/** Runs migration 0070 against what the test seeded: the guard, the payout snapshot, the purge and the drops. A no-op once the tables are gone. */
export async function dropConversationTables(): Promise<void> {
  if (!(await conversationTablesExist())) return;
  const { db } = await import('@/lib/infra/db');
  const { sql } = await import('drizzle-orm');
  for (const statement of await migration0070()) await db().execute(sql.raw(statement));
}

/**
 * Every integration file starts with the invitation, starter task and
 * check-in rewards off (amounts 0, invitations on), so suites about other things see
 * the balances they always did. tests/integration/invites.test.ts turns
 * them on itself through the console's save.
 */
export async function resetRewardSettings(): Promise<void> {
  const { db, schema } = await import('@/lib/infra/db');
  const off = {
    invitesEnabled: true,
    withdrawableInvites: 1_000,
    withdrawableInvitesPerInviter: 20,
    inviteCredits: 0,
    firstReeCredits: 0,
    firstPostCredits: 0,
    firstHelpfulCredits: 0,
    checkInCredits: 0,
    checkInMaxDays: 30,
    checkInWindowMonths: 3,
    revision: crypto.randomUUID(),
    updatedBy: null,
  };
  await db().insert(schema.rewardSettings).values(off).onConflictDoUpdate({ target: schema.rewardSettings.id, set: off });
}

beforeAll(async () => {
  if (TEST_DATABASE_URL) await resetRewardSettings();
});
