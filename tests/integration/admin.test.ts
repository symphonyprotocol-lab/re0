/**
 * Acceptance: the first visitor of an empty installation registers the owner;
 * afterwards registration is closed and sign-in needs password + TOTP. The
 * model page keeps one active entry per kind and freezes it; embedding goes
 * through the re-embed job (step 5; the job itself is tested in step5.test.ts).
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { TEST_DATABASE_URL, uniqueName } from './setup';
import { and, eq, sql } from 'drizzle-orm';

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;
vi.mock('@/lib/infra/ai/gateway-generation-pricing', () => ({ gatewayGenerationPricing: async () => undefined }));

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
    // Other files bootstrap administrators in the same database; only this one's registration counts.
    const audit = await db().select().from(schema.adminAudit).where(and(eq(schema.adminAudit.action, 'admin.bootstrap'), eq(schema.adminAudit.administratorId, owner.id)));
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

  it('throttles wrong passwords per address without locking the account', async () => {
    const at = new Date(Date.now() + 120_000);
    const attacker = '203.0.113.7';
    /* The replayed code in the test above was a right password with a spent step: one TOTP try. */
    const [before] = await db().select().from(schema.administrator).where(eq(schema.administrator.email, email));
    expect(before).toMatchObject({ failedAttempts: 1, lockedUntil: null });
    for (let i = 0; i < 5; i += 1) {
      await expect(admin.signInAdministrator({ email, password: 'wrong', code: '123456', ip: attacker }, at)).rejects.toMatchObject({ code: 'invalid_credentials' });
    }
    /* The sixth try from that address is refused before anything is checked, even with the right credentials. */
    await expect(admin.signInAdministrator({ email, password, code: await code(secret, at), ip: attacker }, at)).rejects.toBeInstanceOf(admin.AdminRateLimitError);
    /* The owner, elsewhere, is not locked out by a stranger who only knows the email. */
    const [row] = await db().select().from(schema.administrator).where(eq(schema.administrator.email, email));
    expect(row).toMatchObject({ failedAttempts: 1, lockedUntil: null });
    const session = await admin.signInAdministrator({ email, password, code: await code(secret, at), ip: '198.51.100.1' }, at);
    await admin.closeAdminSession(session.token);
  });

  it('throttles one address across emails', async () => {
    const at = new Date(Date.now() + 150_000);
    const address = '203.0.113.8';
    for (let i = 0; i < admin.ADMIN_LOGIN_RATE.address; i += 1) {
      await expect(admin.signInAdministrator({ email: `nobody-${i}@example.test`, password: 'wrong', code: '123456', ip: address }, at)).rejects.toMatchObject({ code: 'invalid_credentials' });
    }
    await expect(admin.signInAdministrator({ email: 'another@example.test', password: 'wrong', code: '123456', ip: address }, at)).rejects.toBeInstanceOf(admin.AdminRateLimitError);
  });

  it('counts parallel TOTP guesses atomically and locks after five', async () => {
    const at = new Date(Date.now() + 180_000);
    const right = await code(secret, at);
    const wrong = right === '000000' ? '111111' : '000000';
    /* Ten guesses at once, each from its own address so the address throttle stays out of it. */
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => admin.signInAdministrator({ email, password, code: wrong, ip: `192.0.2.${10 + i}` }, at)),
    );
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    const [row] = await db().select().from(schema.administrator).where(eq(schema.administrator.email, email));
    /* Only five reached the code check; the rest met the lock. */
    expect(row!.failedAttempts).toBe(5);
    expect(row!.lockedUntil!.getTime()).toBe(at.getTime() + 15 * 60_000);
    await expect(admin.signInAdministrator({ email, password, code: right, ip: '192.0.2.99' }, at)).rejects.toMatchObject({ code: 'invalid_credentials' });
    const locked = await db().select().from(schema.adminAudit).where(and(eq(schema.adminAudit.action, 'admin.login.locked'), eq(schema.adminAudit.administratorId, row!.id)));
    expect(locked).toHaveLength(1);

    /* The lock runs out and the count starts over. */
    const after = new Date(at.getTime() + 16 * 60_000);
    const session = await admin.signInAdministrator({ email, password, code: await code(secret, after), ip: '192.0.2.99' }, after);
    const [reset] = await db().select().from(schema.administrator).where(eq(schema.administrator.email, email));
    expect(reset).toMatchObject({ failedAttempts: 0, lockedUntil: null });
    await admin.closeAdminSession(session.token);
  });

  it('sweeps expired console sessions on sign-in', async () => {
    const at = new Date(Date.now() + 40 * 60_000);
    const [row] = await db().select().from(schema.administrator).where(eq(schema.administrator.email, email));
    const stale = await admin.openAdminSession(row!.id, new Date(at.getTime() - 30 * 24 * 60 * 60_000));
    const staleId = await admin.adminSessionHash(stale.token);
    const session = await admin.signInAdministrator({ email, password, code: await code(secret, at), ip: '192.0.2.200' }, at);
    expect(await db().select().from(schema.adminSession).where(eq(schema.adminSession.id, staleId))).toHaveLength(0);
    await admin.closeAdminSession(session.token);
  });
});

describeWithDb('model configuration', () => {
  /* Later files answer through the environment fallback, not these entries. */
  afterAll(async () => {
    await db().delete(schema.reembedJob);
    await db().delete(schema.modelConfig);
  });

  it('migrates the existing active generation model to both audiences', async () => {
    const migration = await readFile(new URL('../../db/migrations/0015_generation_audiences.sql', import.meta.url), 'utf8');
    await db().transaction(async (tx) => {
      /* A temporary legacy table isolates the data migration from the real test schema. */
      await tx.execute(sql`create temporary table model_config (id text primary key, kind text not null, enabled boolean not null) on commit drop`);
      await tx.execute(sql`insert into model_config values ('live', 'generation', true), ('candidate', 'generation', false), ('embed', 'embedding', true)`);
      for (const statement of migration.split('--> statement-breakpoint')) await tx.execute(sql.raw(statement));
      const rows = await tx.execute(sql`select id, enabled_plan from model_config order by id`);
      expect(rows.rows).toEqual([
        { id: 'candidate', enabled_plan: false },
        { id: 'embed', enabled_plan: false },
        { id: 'live', enabled_plan: true },
      ]);
    });
  });

  it('keeps one active entry per kind, freezes it, and switches generation at once', async () => {
    const [owner] = await db().select().from(schema.administrator).limit(1);
    await db().delete(schema.reembedJob);
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

  it('switches Free and Plan independently, including shared models and separate caches', async () => {
    const [owner] = await db().select().from(schema.administrator).limit(1);
    const create = (name: string) => models.createModelConfig(owner!.id, { name, kind: 'generation', transport: 'gateway', model: `openai/${name}`, apiKey: '' });
    const free = await create('free');
    const plan = await create('plan');
    const next = await create('next');
    await models.activateModelConfig(owner!.id, free.id, 'free');
    await models.activateModelConfig(owner!.id, free.id, 'plan');
    expect((await endpointFor('generation')).configId).toBe(free.id);
    expect((await endpointFor('generation', Date.now(), 'plan')).configId).toBe(free.id);

    await models.activateModelConfig(owner!.id, plan.id, 'plan');
    expect((await endpointFor('generation')).configId).toBe(free.id);
    expect((await endpointFor('generation', Date.now(), 'plan')).configId).toBe(plan.id);
    await expect(db().update(schema.modelConfig).set({ enabledPlan: true }).where(eq(schema.modelConfig.id, free.id))).rejects.toThrow();
    await expect(models.updateModelConfig(owner!.id, plan.id, { name: 'Plan', transport: 'gateway', model: 'openai/changed' })).rejects.toMatchObject({ code: 'locked' });
    await models.activateModelConfig(owner!.id, next.id, 'free');
    expect((await endpointFor('generation')).configId).toBe(next.id);
    expect((await endpointFor('generation', Date.now(), 'plan')).configId).toBe(plan.id);

    /* Both candidates race for one slot; both operations must complete successfully. */
    await Promise.all([models.activateModelConfig(owner!.id, free.id, 'plan'), models.activateModelConfig(owner!.id, next.id, 'plan')]);
    const board = await models.listModelConfigs();
    expect(board.configs.filter((row) => row.kind === 'generation' && row.enabled)).toHaveLength(1);
    expect(board.configs.filter((row) => row.enabledPlan)).toHaveLength(1);
    expect((await endpointFor('generation')).configId).toBe(next.id);

    await db().update(schema.modelConfig).set({ enabledPlan: false }).where(eq(schema.modelConfig.kind, 'generation'));
    forgetModelCache();
    expect((await endpointFor('generation', Date.now(), 'plan')).configId).toBeNull();
    expect((await endpointFor('generation')).configId).toBe(next.id);
  });

  it('routes an embedding switch through the re-embed job once passages exist', async () => {
    const [owner] = await db().select().from(schema.administrator).limit(1);
    const candidate = await models.createModelConfig(owner!.id, { name: 'Embed', kind: 'embedding', transport: 'gateway', model: 'openai/text-embedding-3-large', apiKey: 'k' });
    await expect(models.activateModelConfig(owner!.id, candidate.id, 'plan')).rejects.toMatchObject({ code: 'audience' });
    const [anyChunk] = await db().select({ id: schema.chunk.id }).from(schema.chunk).limit(1);
    const result = await models.activateModelConfig(owner!.id, candidate.id);
    if (anyChunk) {
      expect(result).toMatchObject({ activated: false, reembed: true });
      const [row] = await db().select().from(schema.modelConfig).where(eq(schema.modelConfig.id, candidate.id));
      expect(row?.enabled).toBe(false);
      /* Not run here: the job would need the gateway. */
      await db().update(schema.reembedJob).set({ status: 'failed', error: 'test' }).where(eq(schema.reembedJob.status, 'running'));
    } else {
      expect(result).toMatchObject({ activated: true, reembed: false });
    }
  });
});
