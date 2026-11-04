import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_DATABASE_URL } from './setup';
import { eq, sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { db, schema } from '@/lib/infra/db';
import { openCredential } from '@/lib/infra/crypto/credentials';
import { claimFirecrawlKey, recordFirecrawlKeyResult } from '@/lib/infra/firecrawl/keys';
import { deleteFirecrawlKey, listFirecrawlKeys, saveFirecrawlKey } from '@/lib/services/firecrawl-keys';
import { documentSections } from '@/lib/infra/connectors';

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;
const administratorId = crypto.randomUUID();
const keyA = 'fc-test-primary-1111';
const keyB = 'fc-test-secondary-2222';
const add = (name: string, apiKey: string, enabled = true, isFallback = false) => saveFirecrawlKey(administratorId, null, { name, apiKey, enabled, isFallback });

describeWithDb('Firecrawl console and shared key pool', () => {
  beforeEach(async () => { await db().delete(schema.firecrawlKey); });
  afterEach(async () => {
    vi.unstubAllGlobals(); vi.unstubAllEnvs();
    await db().delete(schema.firecrawlKey);
    await db().delete(schema.adminAudit).where(eq(schema.adminAudit.administratorId, administratorId));
  });

  it('encrypts keys and exposes only safe metadata in listings and audit records', async () => {
    const saved = await add('Primary', keyA);
    const [stored] = await db().select().from(schema.firecrawlKey).where(eq(schema.firecrawlKey.id, saved.id));
    expect(stored!.apiKeyCipher).not.toContain(keyA);
    expect(await openCredential(stored!.apiKeyCipher, 'provider')).toBe(keyA);
    expect(saved.apiKeyTail).toBe('1111');
    const listed = await listFirecrawlKeys();
    expect(listed.keys[0]).not.toHaveProperty('apiKeyCipher');
    expect(listed.keys[0]).not.toHaveProperty('apiKeyHash');
    const audits = await db().select().from(schema.adminAudit).where(eq(schema.adminAudit.target, saved.id));
    expect(JSON.stringify([saved, listed, audits])).not.toContain(keyA);
    expect(audits[0]!.after).toEqual({ name: 'Primary', apiKeyTail: '1111', enabled: true, isFallback: false });
  });

  it('keeps blank edited keys, rejects duplicates and immediately applies replacement keys', async () => {
    const a = await add('Primary', keyA);
    await expect(add('Duplicate', keyA)).rejects.toMatchObject({ code: 'duplicate' });
    await saveFirecrawlKey(administratorId, a.id, { name: 'Renamed', apiKey: '', enabled: false });
    expect((await claimFirecrawlKey()).credential).toBeNull();
    await saveFirecrawlKey(administratorId, a.id, { name: 'Renamed', apiKey: '', enabled: true });
    const old = (await claimFirecrawlKey()).credential!;
    expect(old.apiKey).toBe(keyA);
    await recordFirecrawlKeyResult(old, 429, '600');
    await saveFirecrawlKey(administratorId, a.id, { name: 'Replaced', apiKey: keyB, enabled: true });
    // A late response using the old key must not cool down its replacement.
    await recordFirecrawlKeyResult(old, 401);
    const replacement = (await claimFirecrawlKey()).credential!;
    expect(replacement.apiKey).toBe(keyB);
    expect((await listFirecrawlKeys()).keys[0]!.cooldownUntil).toBeNull();
    await deleteFirecrawlKey(administratorId, a.id);
    expect(await claimFirecrawlKey()).toEqual({ managed: false, credential: null });
    await expect(deleteFirecrawlKey(administratorId, a.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rotates keys in least-recently-used order', async () => {
    const a = await add('Primary', keyA);
    const b = await add('Secondary', keyB);
    const claims = [];
    for (let i = 0; i < 6; i += 1) claims.push((await claimFirecrawlKey()).credential!.id);
    expect(claims).toEqual([a.id, b.id, a.id, b.id, a.id, b.id]);
  });

  it('shares rotation fairly between concurrent requests', async () => {
    const a = await add('Primary', keyA);
    const b = await add('Secondary', keyB);
    const claims = await Promise.all(Array.from({ length: 8 }, () => claimFirecrawlKey()));
    expect(claims.filter((claim) => claim.credential?.id === a.id)).toHaveLength(4);
    expect(claims.filter((claim) => claim.credential?.id === b.id)).toHaveLength(4);
    expect((await listFirecrawlKeys()).keys.map((key) => key.useCount)).toEqual([4, 4]);
  });

  it('keeps the main account unused while ordinary keys rotate, including concurrent requests', async () => {
    const main = await add('主账号', 'fc-test-main-0000', true, true);
    const a = await add('备用1', keyA);
    const b = await add('备用2', keyB);
    const claims = await Promise.all(Array.from({ length: 12 }, () => claimFirecrawlKey()));
    expect(claims.filter((claim) => claim.credential?.id === a.id)).toHaveLength(6);
    expect(claims.filter((claim) => claim.credential?.id === b.id)).toHaveLength(6);
    const saved = (await listFirecrawlKeys()).keys.find((key) => key.id === main.id)!;
    expect(saved.useCount).toBe(0);
    expect(saved.lastUsedAt).toBeNull();
  });

  it('uses the main account repeatedly when ordinary keys are unavailable, then returns to a recovered key', async () => {
    const main = await add('主账号', 'fc-test-main-0000', true, true);
    const a = await add('Disabled', keyA, false);
    const b = await add('Cooling', keyB);
    const c = await add('Unreadable', 'fc-test-broken-3333');
    await db().update(schema.firecrawlKey).set({ cooldownUntil: new Date(Date.now() + 600_000) }).where(eq(schema.firecrawlKey.id, b.id));
    await db().update(schema.firecrawlKey).set({ apiKeyCipher: 'unreadable' }).where(eq(schema.firecrawlKey.id, c.id));
    for (let i = 0; i < 3; i += 1) expect((await claimFirecrawlKey()).credential?.id).toBe(main.id);
    // Even a main account that has never been used must lose priority to a recovered ordinary key.
    await db().update(schema.firecrawlKey).set({ lastUsedAt: null }).where(eq(schema.firecrawlKey.id, main.id));
    await db().update(schema.firecrawlKey).set({ cooldownUntil: new Date(Date.now() - 1000) }).where(eq(schema.firecrawlKey.id, b.id));
    expect((await claimFirecrawlKey()).credential?.id).toBe(b.id);
    await saveFirecrawlKey(administratorId, a.id, { name: a.name, apiKey: '', enabled: true });
    expect((await claimFirecrawlKey()).credential?.id).toBe(a.id);
  });

  it.each([401, 402, 403, 429])('only reaches the main account after every ordinary key fails with HTTP %i', async (status) => {
    const mainKey = 'fc-test-main-0000';
    await add('主账号', mainKey, true, true);
    const a = await add('备用1', keyA);
    await add('备用2', keyB);
    vi.stubEnv('FIRECRAWL_BASE_URL', '');
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const auth = new Headers(init.headers).get('authorization')!;
      requests.push(auth);
      if (auth !== `Bearer ${mainKey}`) return new Response('', { status, headers: { 'retry-after': '90' } });
      return Response.json({ success: true, data: { pages: [{ pageNumber: 3, markdown: 'Fallback PDF content.' }], markdown: 'Fallback Word content.' } });
    }));
    expect(await documentSections(new Uint8Array([1]), 'manual.pdf')).toEqual([{ text: 'Fallback PDF content.', locator: { page: 3 } }]);
    expect(requests).toEqual([`Bearer ${keyA}`, `Bearer ${keyB}`, `Bearer ${mainKey}`]);
    expect(await documentSections(new Uint8Array([1]), 'manual.docx')).toEqual([{ text: 'Fallback Word content.', locator: {} }]);
    expect(requests.at(-1)).toBe(`Bearer ${mainKey}`);
    // On recovery the ordinary key handles the next parse, without consuming main-account traffic.
    await db().update(schema.firecrawlKey).set({ cooldownUntil: null }).where(eq(schema.firecrawlKey.id, a.id));
    requests.length = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      requests.push(new Headers(init.headers).get('authorization')!);
      return Response.json({ success: true, data: { markdown: 'Recovered Word content.' } });
    }));
    await documentSections(new Uint8Array([1]), 'manual.docx');
    expect(requests).toEqual([`Bearer ${keyA}`]);
  });

  it('keeps exactly one fallback account and preserves its role when an older client omits the flag', async () => {
    const a = await add('First main', keyA, true, true);
    const b = await add('New main', keyB, true, true);
    expect((await listFirecrawlKeys()).keys.filter((key) => key.isFallback).map((key) => key.id)).toEqual([b.id]);
    await saveFirecrawlKey(administratorId, b.id, { name: 'Renamed main', apiKey: '', enabled: false });
    expect((await listFirecrawlKeys()).keys.find((key) => key.id === b.id)!.isFallback).toBe(true);
    expect((await claimFirecrawlKey()).credential?.id).toBe(a.id);
    await db().update(schema.firecrawlKey).set({ enabled: false }).where(eq(schema.firecrawlKey.id, a.id));
    expect((await claimFirecrawlKey()).credential).toBeNull();
    await saveFirecrawlKey(administratorId, b.id, { name: 'Renamed main', apiKey: '', enabled: true });
    expect((await claimFirecrawlKey()).credential?.id).toBe(b.id);
    const audits = await db().select().from(schema.adminAudit).where(eq(schema.adminAudit.target, a.id));
    expect(audits.some((entry) => (entry.before as { isFallback?: boolean } | null)?.isFallback === true && (entry.after as { isFallback?: boolean } | null)?.isFallback === false)).toBe(true);
  });

  it.each([true, false])('migrates existing keys without depending on unique main-account names (main exists: %s)', async (hasMain) => {
    const migration = readFileSync('db/migrations/0014_firecrawl_fallback.sql', 'utf8');
    await db().transaction(async (tx) => {
      // A transaction-local old-schema table shadows the real table and disappears on commit.
      await tx.execute(sql`create temporary table firecrawl_key (id uuid primary key, name text not null, created_at timestamptz not null) on commit drop`);
      await tx.execute(sql`insert into firecrawl_key values
        ('00000000-0000-0000-0000-000000000001', ${hasMain ? '主账号' : 'Account 1'}, '2026-01-01'),
        ('00000000-0000-0000-0000-000000000002', ${hasMain ? '主账号' : 'Account 2'}, '2026-01-02'),
        ('00000000-0000-0000-0000-000000000003', '备用 1', '2026-01-03')`);
      for (const statement of migration.split('--> statement-breakpoint')) await tx.execute(sql.raw(statement));
      const rows = await tx.execute<{ id: string; is_fallback: boolean }>(sql`select id, is_fallback from firecrawl_key order by id`);
      expect(rows.rows.map((row) => row.is_fallback)).toEqual([hasMain, false, false]);
    });
  });

  it('skips disabled, cooling and unreadable keys, and reuses keys after cooldown', async () => {
    const a = await add('Primary', keyA);
    const b = await add('Secondary', keyB, false);
    const credential = (await claimFirecrawlKey()).credential!;
    await recordFirecrawlKeyResult(credential, 429, '600');
    expect(await claimFirecrawlKey()).toEqual({ managed: true, credential: null });
    await db().update(schema.firecrawlKey).set({ cooldownUntil: new Date(Date.now() - 1000) }).where(eq(schema.firecrawlKey.id, a.id));
    expect((await claimFirecrawlKey()).credential?.id).toBe(a.id);
    await db().update(schema.firecrawlKey).set({ apiKeyCipher: 'unreadable', lastUsedAt: null }).where(eq(schema.firecrawlKey.id, a.id));
    await saveFirecrawlKey(administratorId, b.id, { name: 'Secondary', apiKey: '', enabled: true });
    expect((await claimFirecrawlKey()).credential?.id).toBe(b.id);
    expect((await listFirecrawlKeys()).keys.find((key) => key.id === a.id)!.lastStatus).toBe(0);
  });

  it.each([401, 402, 403, 429])('parses with the next key after HTTP %i and retains the PDF page locator', async (status) => {
    const a = await add('Primary', keyA);
    await add('Secondary', keyB);
    vi.stubEnv('FIRECRAWL_API_KEY', 'fc-environment-must-not-be-used');
    vi.stubEnv('FIRECRAWL_BASE_URL', '');
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const auth = new Headers(init.headers).get('authorization')!;
      requests.push(auth);
      if (auth === `Bearer ${keyA}`) return new Response('', { status, headers: { 'retry-after': '90' } });
      return Response.json({ success: true, data: { pages: [{ pageNumber: 3, markdown: 'The warranty lasts two years.' }] } });
    }));
    expect(await documentSections(new Uint8Array([37, 80, 68, 70]), 'manual.pdf')).toEqual([{ text: 'The warranty lasts two years.', locator: { page: 3 } }]);
    expect(requests).toEqual([`Bearer ${keyA}`, `Bearer ${keyB}`]);
    const saved = (await listFirecrawlKeys()).keys.find((key) => key.id === a.id)!;
    expect(saved.lastStatus).toBe(status);
    expect(saved.cooldownUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  it('does not retry network failures or silently use an environment key when all console keys are disabled', async () => {
    const a = await add('Primary', keyA);
    await add('Secondary', keyB);
    const fetchMock = vi.fn().mockRejectedValue(new Error('uncertain request outcome'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(documentSections(new Uint8Array([1]), 'manual.pdf')).rejects.toMatchObject({ code: 'parse_failed' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const saved = (await listFirecrawlKeys()).keys.find((key) => key.id === a.id)!;
    expect(saved.lastStatus).toBe(0);
    for (const key of (await listFirecrawlKeys()).keys) await saveFirecrawlKey(administratorId, key.id, { name: key.name, enabled: false, apiKey: '' });
    vi.stubEnv('FIRECRAWL_API_KEY', 'fc-environment-must-not-be-used');
    await expect(documentSections(new Uint8Array([1]), 'manual.pdf')).rejects.toMatchObject({ code: 'parse_failed' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
