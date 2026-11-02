/**
 * Acceptance: the first visitor of an empty installation registers the owner;
 * afterwards registration is closed and sign-in needs password + TOTP. The
 * model page keeps one active entry per kind and freezes it; embedding goes
 * through the re-embed placeholder.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { TEST_DATABASE_URL, uniqueName } from './setup';
import { and, eq } from 'drizzle-orm';

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const admin = await import('@/lib/services/admin');
const models = await import('@/lib/services/models');
const { totpCounter } = await import('@/lib/domain/totp');
const { db, schema } = await import('@/lib/infra/db');
const { endpointFor, forgetModelCache } = await import('@/lib/infra/ai/models');

/** RFC 6238 code for a base32 secret at a given time, computed independently of the code under test. */
async function code(secret: string, at = new Date()): Promise<string> {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of secret) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  let counter = totpCounter(at);
  const message = new Uint8Array(8);
  for (let i = 7; i >= 0; i -= 1) {
    message[i] = counter & 255;
    counter = Math.floor(counter / 256);
  }
  const key = await crypto.subtle.importKey('raw', new Uint8Array(bytes), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, message));
  const offset = digest[19]! & 15;
  const binary = ((digest[offset]! & 127) << 24) | (digest[offset + 1]! << 16) | (digest[offset + 2]! << 8) | digest[offset + 3]!;
  return String(binary % 1_000_000).padStart(6, '0');
}

describeWithDb('console authority', () => {
  const email = `${uniqueName('owner')}@example.test`;
  const password = 'correct horse battery';
  let secret = '';

  it('registers the first administrator once', async () => {
    await db().delete(schema.adminSession);
    await db().delete(schema.administrator);
    expect(await admin.hasAdministrator()).toBe(false);
    const challenge = await admin.bootstrapChallenge();
    secret = challenge.secret;
    await expect(admin.bootstrapFirstAdministrator({ name: 'Owner', email, password: 'short', sealedSecret: challenge.sealed, code: await code(secret) })).rejects.toMatchObject({ code: 'password' });
    await expect(admin.bootstrapFirstAdministrator({ name: 'Owner', email, password, sealedSecret: challenge.sealed, code: '000000' === (await code(secret)) ? '111111' : '000000' })).rejects.toMatchObject({ code: 'totp' });
    const owner = await admin.bootstrapFirstAdministrator({ name: 'Owner', email, password, sealedSecret: challenge.sealed, code: await code(secret) });
    expect(owner).toMatchObject({ role: 'owner', email });

    const second = await admin.bootstrapChallenge();
    await expect(
      admin.bootstrapFirstAdministrator({ name: 'Intruder', email: 'intruder@example.test', password, sealedSecret: second.sealed, code: await code(second.secret) }),
    ).rejects.toMatchObject({ code: 'bootstrap_closed' });
    const audit = await db().select().from(schema.adminAudit).where(eq(schema.adminAudit.action, 'admin.bootstrap'));
    expect(audit).toHaveLength(1);
  });

  it('signs in with password and a fresh TOTP step, and spends the step', async () => {
    const later = new Date(Date.now() + 60_000);
    const session = await admin.signInAdministrator({ email, password, code: await code(secret, later) }, later);
    expect((await admin.resolveAdminSession(session.token, later))?.email).toBe(email);
    await expect(admin.signInAdministrator({ email, password, code: await code(secret, later) }, later)).rejects.toMatchObject({ code: 'invalid_credentials' });
    await admin.closeAdminSession(session.token);
    expect(await admin.resolveAdminSession(session.token, later)).toBeNull();
  });

  it('locks the account after five failures', async () => {
    const at = new Date(Date.now() + 120_000);
    for (let i = 0; i < 5; i += 1) {
      await expect(admin.signInAdministrator({ email, password: 'wrong', code: '123456' }, at)).rejects.toMatchObject({ code: 'invalid_credentials' });
    }
    await expect(admin.signInAdministrator({ email, password, code: await code(secret, at) }, at)).rejects.toMatchObject({ code: 'invalid_credentials' });
    await db().update(schema.administrator).set({ failedAttempts: 0, lockedUntil: null }).where(eq(schema.administrator.email, email));
  });
});

describeWithDb('model configuration', () => {
  /* Later files answer through the environment fallback, not these entries. */
  afterAll(async () => {
    await db().delete(schema.modelConfig);
  });

  it('keeps one active entry per kind, freezes it, and switches generation at once', async () => {
    const [owner] = await db().select().from(schema.administrator).limit(1);
    await db().delete(schema.modelConfig);
    forgetModelCache();
    const first = await models.createModelConfig(owner!.id, { name: 'One', kind: 'generation', transport: 'gateway', model: 'openai/gpt-5-mini', apiKey: 'sk-one-1234' });
    expect(first).toMatchObject({ enabled: false, apiKeyTail: '1234', hasKey: true });
    expect(first).not.toHaveProperty('apiKeyCipher');
    const second = await models.createModelConfig(owner!.id, { name: 'Two', kind: 'generation', transport: 'gateway', model: 'anthropic/claude-sonnet-5-5', apiKey: '' });
    expect(second.apiKeyTail).toBe('1234');

    await models.activateModelConfig(owner!.id, first.id);
    expect((await endpointFor('generation')).model).toBe('openai/gpt-5-mini');
    await models.activateModelConfig(owner!.id, second.id);
    expect((await endpointFor('generation')).model).toBe('anthropic/claude-sonnet-5-5');
    const active = await db().select().from(schema.modelConfig).where(and(eq(schema.modelConfig.kind, 'generation'), eq(schema.modelConfig.enabled, true)));
    expect(active.map((row) => row.id)).toEqual([second.id]);

    await expect(models.updateModelConfig(owner!.id, second.id, { name: 'Two', transport: 'gateway', model: 'openai/gpt-5', timeoutMs: 60000 })).rejects.toMatchObject({ code: 'locked' });
    const renamed = await models.updateModelConfig(owner!.id, second.id, { name: 'Two renamed', transport: 'gateway', model: 'anthropic/claude-sonnet-5-5', timeoutMs: 30000 });
    expect(renamed).toMatchObject({ name: 'Two renamed', timeoutMs: 30000 });

    const actions = (await db().select({ action: schema.adminAudit.action }).from(schema.adminAudit)).map((row) => row.action);
    expect(actions).toEqual(expect.arrayContaining(['model.create', 'model.activate', 'model.update']));
  });

  it('never carries a stored key to another host', async () => {
    const [owner] = await db().select().from(schema.administrator).limit(1);
    const saved = await models.createModelConfig(owner!.id, { name: 'A', kind: 'transcription', transport: 'openai_compatible', baseUrl: 'https://a.example/v1', model: 'whisper-1', apiKey: 'sk-aaaa9999' });
    const moved = await models.updateModelConfig(owner!.id, saved.id, { name: 'A', transport: 'openai_compatible', baseUrl: 'https://evil.example/v1', model: 'whisper-1', timeoutMs: 60000 });
    expect(moved).toMatchObject({ hasKey: false, apiKeyTail: null });
  });

  it('routes an embedding switch through the re-embed job once passages exist', async () => {
    const [owner] = await db().select().from(schema.administrator).limit(1);
    const candidate = await models.createModelConfig(owner!.id, { name: 'Embed', kind: 'embedding', transport: 'gateway', model: 'openai/text-embedding-3-large', apiKey: 'k' });
    const [anyChunk] = await db().select({ id: schema.chunk.id }).from(schema.chunk).limit(1);
    const result = await models.activateModelConfig(owner!.id, candidate.id);
    if (anyChunk) {
      expect(result).toEqual({ activated: false, reembed: true });
      const [row] = await db().select().from(schema.modelConfig).where(eq(schema.modelConfig.id, candidate.id));
      expect(row?.enabled).toBe(false);
    } else {
      expect(result).toEqual({ activated: true, reembed: false });
    }
  });
});
