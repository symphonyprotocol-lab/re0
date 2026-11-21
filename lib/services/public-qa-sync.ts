/**
 * #158's public Q&A as posts (v5): every `ree_public_qa` row that went
 * public -- published, or hidden after it was -- becomes a post with that
 * one answer, carrying who hid it, its pin, helpful count, votes and
 * reports. Pending rows follow once their review publishes them; rejected
 * ones were never shown and stay where they are. Nothing is deleted from
 * the old tables.
 *
 * Every statement skips what it already copied (`legacy_qa_id`, the votes'
 * and reports' keys), so this runs again at any time without copying
 * twice: in migration 0056, after each review that publishes, and hourly.
 * A copied post is published with its answer; who asked is never shown
 * (as before).
 */
import { sql } from 'drizzle-orm';
import { db } from '@/lib/infra/db';

/** The statements, in order; migration 0056 ran the same text, then with the `charge` column 0062 dropped (per-answer billing) and the `message_id` one 0070 dropped (the conversations). */
export const SYNC_PUBLIC_QA_STATEMENTS = [
  `insert into post (user_id, source, legacy_qa_id, anonymous, question, lang, category, status, answer_state, answer_count, created_at, published_at, answered_at)
select q.user_id, case q.source when 'user' then 'conversation' else q.source end, q.id, true, left(q.question, 4000), q.lang, r.category,
  'published', 'done', case when q.status = 'published' then 1 else 0 end, q.created_at, coalesce(q.published_at, q.created_at), coalesce(q.published_at, q.created_at)
from ree_public_qa q join ree r on r.id = q.ree_id
where q.status in ('published', 'hidden') and not exists (select 1 from post p where p.legacy_qa_id = q.id)
on conflict (legacy_qa_id) where legacy_qa_id is not null do nothing`,
  `insert into post_answer (post_id, ree_id, legacy_qa_id, state, text, citations, hidden_by, helpful_count, report_count, pinned_at, created_at, answered_at)
select p.id, q.ree_id, q.id, 'answered', q.answer, q.citations, case when q.status = 'hidden' then coalesce(q.hidden_by, 'admin') end, q.helpful_count, q.report_count,
  case when q.status = 'published' and not exists (select 1 from post_answer pa where pa.ree_id = q.ree_id and pa.pinned_at is not null) then q.pinned_at end,
  q.created_at, coalesce(q.published_at, q.created_at)
from ree_public_qa q join post p on p.legacy_qa_id = q.id
where not exists (select 1 from post_answer a where a.legacy_qa_id = q.id)
on conflict do nothing`,
  `insert into post_answer_vote (answer_id, user_id, created_at)
select a.id, v.user_id, v.created_at from ree_public_qa_vote v join post_answer a on a.legacy_qa_id = v.qa_id
on conflict do nothing`,
  `insert into post_answer_report (answer_id, reporter_key, created_at)
select a.id, r.reporter_key, r.created_at from ree_public_qa_report r join post_answer a on a.legacy_qa_id = r.qa_id
on conflict do nothing`,
] as const;

/** Copies what is not copied yet; answers how many posts it added. */
export async function syncPublicQa(): Promise<number> {
  let added = 0;
  for (const [at, statement] of SYNC_PUBLIC_QA_STATEMENTS.entries()) {
    const result = await db().execute(sql.raw(statement));
    if (at === 0) added = result.rowCount ?? 0;
  }
  return added;
}
