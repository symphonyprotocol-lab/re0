/**
 * The reaper for question holds (review H5). A question's holds are placed
 * in their own transaction and closed only by the stream that answers it; a
 * function killed mid-answer (timeout, redeploy, crash) or a release that
 * itself failed leaves them held for good. Video and knowledge have their
 * own recovery; this is the one for chat and MCP questions and for
 * round-table syntheses (which otherwise recover only when asked again).
 *
 * A chat hold whose question is older than `CHAT_HOLD_STALE_MS` -- far past
 * the route's 300-second limit -- belongs to no live stream. It is released
 * in full under its own sub-ledger's reasons: a Ree that settled had its base
 * and fee holds closed with its reply, so an open one means no answer was
 * stored for it; an open check hold means the check never finished, and the
 * reply is marked as failed. A synthesis hold names its synthesis: one
 * still `running` past `SYNTHESIS_STALE_MS` died, so its fee is released and
 * the row removed, as starting it again would (the request may then be
 * synthesized afresh).
 */
import { and, asc, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import { CHAT_HOLD_REAP_BATCH, CHAT_HOLD_STALE_MS, SYNTHESIS_STALE_MS } from '@/lib/constants';
import { db, schema } from '@/lib/infra/db';
import { releaseHold } from '@/lib/services/credits';

export async function releaseStaleChatHolds(now = new Date(), limit = CHAT_HOLD_REAP_BATCH): Promise<{ released: number; failed: number }> {
  const database = db();
  const stale = await database
    .select({ id: schema.creditHold.id, refId: schema.creditHold.refId, ledger: schema.creditHold.ledger, reeId: schema.creditHold.reeId })
    .from(schema.creditHold)
    .where(
      and(
        eq(schema.creditHold.kind, 'chat'),
        eq(schema.creditHold.status, 'held'),
        lt(schema.creditHold.createdAt, new Date(now.getTime() - CHAT_HOLD_STALE_MS)),
        or(
          inArray(schema.creditHold.refId, database.select({ id: schema.message.id }).from(schema.message).where(eq(schema.message.role, 'user'))),
          inArray(
            schema.creditHold.refId,
            database
              .select({ id: schema.synthesis.id })
              .from(schema.synthesis)
              .where(and(eq(schema.synthesis.status, 'running'), lt(schema.synthesis.createdAt, new Date(now.getTime() - SYNTHESIS_STALE_MS)))),
          ),
        ),
      ),
    )
    .orderBy(asc(schema.creditHold.createdAt))
    .limit(limit);
  let released = 0;
  let failed = 0;
  for (const hold of stale) {
    try {
      const amount = await database.transaction(async (tx) => {
        const given = await releaseHold(tx, hold.id, { note: 'released: the answer never finished' }, now);
        if (given !== null && hold.ledger === 'chat_synthesis' && hold.refId) {
          await tx.delete(schema.synthesis).where(and(eq(schema.synthesis.id, hold.refId), eq(schema.synthesis.status, 'running')));
        }
        if (given !== null && hold.ledger === 'chat_verify' && hold.refId && hold.reeId) {
          await tx
            .update(schema.message)
            .set({ checkState: 'failed' })
            .where(and(eq(schema.message.requestId, hold.refId), eq(schema.message.reeId, hold.reeId), eq(schema.message.role, 'ree'), isNull(schema.message.checkState)));
        }
        return given;
      });
      if (amount !== null) released += 1;
    } catch (error) {
      failed += 1;
      console.error(`chat hold ${hold.id} could not be released: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }
  if (released || failed) console.info(`chat holds: released ${released}, failed ${failed}`);
  return { released, failed };
}
