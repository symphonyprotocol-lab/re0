import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { DEFAULT_VIDEO_EXPORT_CREDITS, DEFAULT_VIDEO_SCRIPT_CREDITS } from '@/lib/constants';
import { validVideoCredits, type CreditAmountView } from '@/lib/domain/pricing';
import { db, schema, type Executor } from '@/lib/infra/db';
import { AdminInputError, audit } from '@/lib/services/admin';

export async function videoScriptPrice(executor: Executor = db()): Promise<CreditAmountView> {
  const [row] = await executor.select({
    credits: schema.videoPricing.scriptCredits,
    revision: schema.videoPricing.revision,
  }).from(schema.videoPricing).where(eq(schema.videoPricing.id, 1)).limit(1);
  return row ?? { credits: DEFAULT_VIDEO_SCRIPT_CREDITS, revision: 'default' };
}

export async function saveVideoScriptPrice(administratorId: string, input: Record<string, unknown>): Promise<CreditAmountView> {
  if (!validVideoCredits(input.credits) || typeof input.revision !== 'string') throw new AdminInputError('invalid_video_script_credits');
  const credits = input.credits;
  return db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('pricing:video_script'))`);
    const before = await videoScriptPrice(tx);
    if (input.revision !== before.revision) throw new AdminInputError('pricing_conflict');
    const next = { credits, revision: randomUUID() };
    const values = { scriptCredits: credits, revision: next.revision, updatedBy: administratorId };
    await tx.insert(schema.videoPricing).values(values).onConflictDoUpdate({
      target: schema.videoPricing.id,
      set: { ...values, updatedAt: new Date() },
    });
    await audit(tx, { administratorId, action: 'pricing.update', target: 'video_script', before, after: next });
    return next;
  });
}

export async function videoExportPrice(executor: Executor = db()): Promise<CreditAmountView> {
  const [row] = await executor.select({
    credits: schema.videoExportPricing.credits,
    revision: schema.videoExportPricing.revision,
  }).from(schema.videoExportPricing).where(eq(schema.videoExportPricing.id, 1)).limit(1);
  return row ?? { credits: DEFAULT_VIDEO_EXPORT_CREDITS, revision: 'default' };
}

export async function saveVideoExportPrice(administratorId: string, input: Record<string, unknown>): Promise<CreditAmountView> {
  if (!validVideoCredits(input.credits) || typeof input.revision !== 'string') throw new AdminInputError('invalid_video_export_credits');
  const credits = input.credits;
  return db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('pricing:video_export'))`);
    const before = await videoExportPrice(tx);
    if (input.revision !== before.revision) throw new AdminInputError('pricing_conflict');
    const next = { credits, revision: randomUUID() };
    const values = { ...next, updatedBy: administratorId };
    await tx.insert(schema.videoExportPricing).values(values).onConflictDoUpdate({
      target: schema.videoExportPricing.id,
      set: { ...values, updatedAt: new Date() },
    });
    await audit(tx, { administratorId, action: 'pricing.update', target: 'video_export', before, after: next });
    return next;
  });
}
