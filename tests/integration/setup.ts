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
    firstQuestionCredits: 0,
    firstCommentCredits: 0,
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
