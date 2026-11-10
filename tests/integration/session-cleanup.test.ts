/**
 * Expired sessions are deleted (review low: `session` / `admin_session` rows
 * were never cleaned up); live ones stay.
 */
import { describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { TEST_DATABASE_URL, uniqueName } from './setup';

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const { clearExpiredSessions, createSession } = await import('@/lib/services/auth');
const admin = await import('@/lib/services/admin');
const { db, schema } = await import('@/lib/infra/db');

describeWithDb('expired session cleanup', () => {
  it('deletes expired user and console sessions in batches and keeps live ones', async () => {
    const subject = uniqueName('sweep');
    const { userId } = await createSession({ provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: 'Sweep', avatarUrl: null }, 'zh', '/');
    const past = new Date(Date.now() - 60_000);
    const stale = Array.from({ length: 5 }, () => ({ id: `stale-${uniqueName('s')}`, userId, expiresAt: past }));
    await db().insert(schema.session).values(stale);
    const [administrator] = await db()
      .insert(schema.administrator)
      .values({ name: 'Sweep', email: `${uniqueName('sweep')}@example.test`, passwordHash: 'x', totpSecretCipher: 'x' })
      .returning({ id: schema.administrator.id });
    const old = await admin.openAdminSession(administrator!.id, new Date(Date.now() - 24 * 60 * 60_000));
    const live = await admin.openAdminSession(administrator!.id);

    const removed = await clearExpiredSessions(new Date(), 2);
    expect(removed.sessions).toBeGreaterThanOrEqual(5);
    expect(removed.adminSessions).toBeGreaterThanOrEqual(1);
    expect(await db().select().from(schema.session).where(inArray(schema.session.id, stale.map((row) => row.id)))).toHaveLength(0);
    /* The session createSession opened is still live. */
    expect(await db().select().from(schema.session).where(eq(schema.session.userId, userId))).toHaveLength(1);
    expect(await admin.resolveAdminSession(old.token)).toBeNull();
    expect(await db().select().from(schema.adminSession).where(eq(schema.adminSession.id, await admin.adminSessionHash(old.token)))).toHaveLength(0);
    expect((await admin.resolveAdminSession(live.token))?.id).toBe(administrator!.id);
  });
});
