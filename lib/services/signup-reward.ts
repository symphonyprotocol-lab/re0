import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { WELCOME_CREDITS } from '@/lib/constants';
import { validWelcomeCredits, type WelcomeCreditsView } from '@/lib/domain/pricing';
import { db, schema, type Executor } from '@/lib/infra/db';
import { AdminInputError, audit } from '@/lib/services/admin';

/** Read inside the registration transaction; never cache the grant amount across requests. */
export async function welcomeCredits(executor: Executor = db()): Promise<WelcomeCreditsView> {
  const [row] = await executor.select().from(schema.signupReward).where(eq(schema.signupReward.id, 1)).limit(1);
  return row ? { credits: row.credits, revision: row.revision } : { credits: WELCOME_CREDITS, revision: 'default' };
}

export async function saveWelcomeCredits(administratorId: string, input: Record<string, unknown>): Promise<WelcomeCreditsView> {
  if (!validWelcomeCredits(input.credits) || typeof input.revision !== 'string') throw new AdminInputError('invalid_welcome_credits');
  const credits = input.credits;
  return db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('pricing:welcome'))`);
    const before = await welcomeCredits(tx);
    if (input.revision !== before.revision) throw new AdminInputError('pricing_conflict');
    const next = { credits, revision: randomUUID() };
    await tx
      .insert(schema.signupReward)
      .values({ ...next, id: 1, updatedBy: administratorId })
      .onConflictDoUpdate({
        target: schema.signupReward.id,
        set: { ...next, updatedBy: administratorId, updatedAt: new Date() },
      });
    await audit(tx, { administratorId, action: 'pricing.update', target: 'welcome', before, after: next });
    return next;
  });
}
