/**
 * The explore ranking, materialised every hour into `ree.rank` (rebuild-
 * proposal.md 4, 8.3 "explore 排序分每小时物化"): for each public Ree, the
 * last 30 days of other people's questions, answers, votes and pulls into
 * private posts, and the quality score made from them. Idempotent.
 */
import { sql } from 'drizzle-orm';
import { QUALITY_WINDOW_DAYS } from '@/lib/constants';
import { qualityScore, type ReeRank } from '@/lib/domain/explore';
import { db, schema } from '@/lib/infra/db';
import { clearRateBuckets } from '@/lib/services/explore';
import { ANSWERED, ASKED, askedByOthers } from '@/lib/services/ree-counts';

type Counts = Record<string, unknown> & {
  id: string;
  asked: number;
  answered: number;
  up: number;
  down: number;
  pulls: number;
  answers_all: number;
  asked7: number;
  last_answered: string | null;
};

export async function computeRanks(now = new Date()): Promise<number> {
  const since = new Date(now.getTime() - QUALITY_WINDOW_DAYS * 86_400_000).toISOString();
  const week = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const owner = sql.raw('o.owner_id');
  /*
   * From posts (ree-counts.ts): the 30-day and 7-day windows count posts only
   * -- the conversations have rolled out of them -- and the all-time order
   * adds the conversations' frozen count. A pull is a Ree someone else chose
   * for a private post, or added to one (加 Ree): its first answer row there.
   */
  const counted = await db().execute<Counts>(sql`
    select r.id,
      coalesce(q.asked, 0)::int as asked,
      coalesce(q.answered, 0)::int as answered,
      coalesce(v.up, 0)::int as up,
      coalesce(d.down, 0)::int as down,
      coalesce(p.pulls, 0)::int as pulls,
      (coalesce(ls.answers_all, 0) + coalesce(a.answers, 0))::int as answers_all,
      (coalesce(w.asked, 0) + coalesce(z.asked, 0))::int as asked7,
      greatest(w.last_at, z.last_at) as last_answered
    from ${schema.ree} r
    left join ${schema.reeLegacyStats} ls on ls.ree_id = r.id
    left join (
      select a.ree_id, count(*) as asked, count(*) filter (where ${ANSWERED}) as answered
      from ${schema.postAnswer} a join ${schema.post} p on p.id = a.post_id join ${schema.ree} o on o.id = a.ree_id
      where ${ASKED} and a.created_at >= ${since}::timestamptz and ${askedByOthers(owner)}
      group by a.ree_id
    ) q on q.ree_id = r.id
    left join (
      select a.ree_id, count(*) as up
      from ${schema.postAnswerVote} x join ${schema.postAnswer} a on a.id = x.answer_id join ${schema.post} p on p.id = a.post_id join ${schema.ree} o on o.id = a.ree_id
      where x.created_at >= ${since}::timestamptz and x.user_id <> o.owner_id and p.source not in ('test', 'competition')
      group by a.ree_id
    ) v on v.ree_id = r.id
    left join (
      select a.ree_id, count(*) as down
      from ${schema.postAnswerFeedback} x join ${schema.postAnswer} a on a.id = x.answer_id join ${schema.post} p on p.id = a.post_id join ${schema.ree} o on o.id = a.ree_id
      where x.created_at >= ${since}::timestamptz and x.user_id <> o.owner_id and p.source not in ('test', 'competition')
      group by a.ree_id
    ) d on d.ree_id = r.id
    left join (
      select pulled.ree_id, count(*) as pulls
      from (
        select a.ree_id, a.post_id, min(a.created_at) as first_at
        from ${schema.postAnswer} a join ${schema.post} p on p.id = a.post_id join ${schema.ree} o on o.id = a.ree_id
        where p.visibility = 'private' and p.source in ('post', 'api') and p.user_id <> o.owner_id
        group by a.ree_id, a.post_id
      ) pulled
      where pulled.first_at >= ${since}::timestamptz
      group by pulled.ree_id
    ) p on p.ree_id = r.id
    left join (
      /* The explore "回答最多" order, all time: once an hour here instead of over every answer on every browse. */
      select a.ree_id, count(*) as answers
      from ${schema.postAnswer} a join ${schema.post} p on p.id = a.post_id join ${schema.ree} o on o.id = a.ree_id
      where ${ANSWERED} and ${askedByOthers(owner)}
      group by a.ree_id
    ) a on a.ree_id = r.id
    left join (
      /* Explore's activity line: other people's questions this week and the latest answer, on posts (signed in, or a share-page visitor's) ... */
      select a.ree_id, count(*) as asked, max(a.answered_at) filter (where ${ANSWERED}) as last_at
      from ${schema.postAnswer} a join ${schema.post} p on p.id = a.post_id join ${schema.ree} o on o.id = a.ree_id
      where ${ASKED} and a.created_at >= ${week}::timestamptz and ${askedByOthers(owner)}
      group by a.ree_id
    ) w on w.ree_id = r.id
    left join (
      /* ... and the old anonymous chat's answers (signed out, until 2026-11). */
      select ree_id, count(*) as asked, max(created_at) as last_at
      from ${schema.anonymousAnswer}
      where created_at >= ${week}::timestamptz
      group by ree_id
    ) z on z.ree_id = r.id
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
        answersAll: row.answers_all,
        quality: qualityScore(row),
        asked7: row.asked7,
        lastAnsweredAt: row.last_answered ? new Date(row.last_answered).toISOString() : null,
        computedAt,
      };
      return sql`(${row.id}::uuid, ${JSON.stringify(rank)}::jsonb)`;
    });
    await db().execute(sql`update ${schema.ree} r set rank = v.rank from (values ${sql.join(batch, sql`, `)}) as v(id, rank) where r.id = v.id`);
  }
  await clearRateBuckets(now);
  return rows.length;
}
