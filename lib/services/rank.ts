/**
 * The explore ranking, materialised every hour into `ree.rank` (rebuild-
 * proposal.md 4, 8.3 "explore 排序分每小时物化"): for each public Ree, the
 * last 30 days of other people's questions, answers, votes and pulls into
 * conversations, and the quality score made from them. Idempotent.
 */
import { sql } from 'drizzle-orm';
import { QUALITY_WINDOW_DAYS } from '@/lib/constants';
import { qualityScore, type ReeRank } from '@/lib/domain/explore';
import { db, schema } from '@/lib/infra/db';
import { clearRateBuckets } from '@/lib/services/explore';

type Counts = Record<string, unknown> & {
  id: string;
  asked: number;
  answered: number;
  up: number;
  down: number;
  pulls: number;
};

export async function computeRanks(now = new Date()): Promise<number> {
  const since = new Date(now.getTime() - QUALITY_WINDOW_DAYS * 86_400_000).toISOString();
  const counted = await db().execute<Counts>(sql`
    select r.id,
      coalesce(q.asked, 0)::int as asked,
      coalesce(q.answered, 0)::int as answered,
      coalesce(v.up, 0)::int as up,
      coalesce(v.down, 0)::int as down,
      coalesce(p.pulls, 0)::int as pulls
    from ${schema.ree} r
    left join (
      select m.ree_id, count(*) as asked, count(*) filter (where not m.no_answer) as answered
      from ${schema.message} m join ${schema.conversation} c on c.id = m.conversation_id join ${schema.ree} o on o.id = m.ree_id
      where m.role = 'ree' and m.created_at >= ${since}::timestamptz and c.user_id <> o.owner_id
      group by m.ree_id
    ) q on q.ree_id = r.id
    left join (
      select m.ree_id, count(*) filter (where f.vote = 'up') as up, count(*) filter (where f.vote = 'down') as down
      from ${schema.reeFeedback} f join ${schema.message} m on m.id = f.message_id join ${schema.ree} o on o.id = m.ree_id
      where f.created_at >= ${since}::timestamptz and f.user_id <> o.owner_id
      group by m.ree_id
    ) v on v.ree_id = r.id
    left join (
      select cr.ree_id, count(*) as pulls
      from ${schema.conversationRee} cr join ${schema.conversation} c on c.id = cr.conversation_id join ${schema.ree} o on o.id = cr.ree_id
      where cr.added_at >= ${since}::timestamptz and c.user_id <> o.owner_id
      group by cr.ree_id
    ) p on p.ree_id = r.id
    where r.is_public and r.is_published and r.moderated_at is null and r.deleted_at is null`);
  const rows = counted.rows;
  const computedAt = now.toISOString();
  for (let at = 0; at < rows.length; at += 500) {
    const batch = rows.slice(at, at + 500).map((row) => {
      const rank: ReeRank = {
        asked30: row.asked,
        answered30: row.answered,
        up30: row.up,
        down30: row.down,
        pulls30: row.pulls,
        activity30: row.asked + row.pulls,
        quality: qualityScore(row),
        computedAt,
      };
      return sql`(${row.id}::uuid, ${JSON.stringify(rank)}::jsonb)`;
    });
    await db().execute(sql`update ${schema.ree} r set rank = v.rank from (values ${sql.join(batch, sql`, `)}) as v(id, rank) where r.id = v.id`);
  }
  await clearRateBuckets(now);
  return rows.length;
}
