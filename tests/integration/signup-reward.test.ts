import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { TEST_DATABASE_URL, uniqueName } from './setup';
import { db, schema } from '@/lib/infra/db';
import { WELCOME_CREDITS } from '@/lib/constants';
import { welcomeCredits, saveWelcomeCredits } from '@/lib/services/signup-reward';
import { createSession } from '@/lib/services/auth';
import { balanceOf } from '@/lib/services/credits';

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;
const profile = (subject: string) => ({
  provider: 'github' as const,
  subject,
  handle: subject,
  email: `${subject}@example.test`,
  displayName: 'Buyer',
  avatarUrl: null,
});

describeWithDb('managed registration gift', () => {
  let owner: string;
  beforeAll(async () => {
    await db().delete(schema.signupReward);
    const [row] = await db()
      .insert(schema.administrator)
      .values({
        email: `${uniqueName('gift-admin')}@example.test`,
        name: 'Gift admin',
        role: 'owner',
        passwordHash: 'test',
        totpSecretCipher: 'test',
      })
      .returning();
    owner = row!.id;
  });
  afterAll(async () => {
    await db().delete(schema.signupReward);
  });

  it('defaults to the constant and changes only future registrations, without Paddle', async () => {
    expect(await welcomeCredits()).toEqual({ credits: WELCOME_CREDITS, revision: 'default' });
    const existingProfile = profile(uniqueName('existing'));
    const existing = await createSession(existingProfile, 'zh', '/dashboard');
    const saved = await saveWelcomeCredits(owner, { credits: 25000, revision: 'default' });
    expect(await welcomeCredits()).toEqual(saved);
    const freshProfile = profile(uniqueName('fresh'));
    const fresh = await createSession(freshProfile, 'en', '/dashboard');
    expect(await balanceOf(db(), existing.userId)).toBe(WELCOME_CREDITS);
    expect(await balanceOf(db(), fresh.userId)).toBe(25000);
    await createSession(existingProfile, 'zh', '/dashboard');
    await createSession(freshProfile, 'en', '/dashboard');
    expect(await balanceOf(db(), existing.userId)).toBe(WELCOME_CREDITS);
    expect(await balanceOf(db(), fresh.userId)).toBe(25000);
    const entries = await db()
      .select()
      .from(schema.creditEntry)
      .where(and(eq(schema.creditEntry.userId, fresh.userId), eq(schema.creditEntry.reason, 'welcome')));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ delta: 25000 });
    const [audit] = await db()
      .select()
      .from(schema.adminAudit)
      .where(and(eq(schema.adminAudit.administratorId, owner), eq(schema.adminAudit.target, 'welcome')));
    expect(audit).toMatchObject({ action: 'pricing.update', before: { credits: WELCOME_CREDITS, revision: 'default' }, after: saved });
  });

  it('rejects invalid amounts and stale revisions without changing the live setting', async () => {
    const current = await welcomeCredits();
    for (const credits of [-1, 0.5, 100000001, '100', null]) {
      await expect(saveWelcomeCredits(owner, { credits, revision: current.revision })).rejects.toMatchObject({
        code: 'invalid_welcome_credits',
      });
    }
    await expect(saveWelcomeCredits(owner, { credits: 1, revision: 'default' })).rejects.toMatchObject({ code: 'pricing_conflict' });
    expect(await welcomeCredits()).toEqual(current);
  });

  it('serializes competing edits and allows disabling the gift without affecting old grants', async () => {
    const current = await welcomeCredits();
    const results = await Promise.allSettled([
      saveWelcomeCredits(owner, { credits: 0, revision: current.revision }),
      saveWelcomeCredits(owner, { credits: 5000, revision: current.revision }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'pricing_conflict' } });
    const enabled = await welcomeCredits();
    await saveWelcomeCredits(owner, { credits: 0, revision: enabled.revision });
    const disabledProfile = profile(uniqueName('disabled-gift'));
    const user = await createSession(disabledProfile, 'en', '/dashboard');
    expect(await balanceOf(db(), user.userId)).toBe(0);
    expect(await db().select().from(schema.creditGrant).where(eq(schema.creditGrant.userId, user.userId))).toHaveLength(0);
    const zero = await welcomeCredits();
    await saveWelcomeCredits(owner, { credits: 75000, revision: zero.revision });
    await createSession(disabledProfile, 'en', '/dashboard');
    expect(await balanceOf(db(), user.userId)).toBe(0);
  });
});
