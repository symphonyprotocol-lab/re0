/**
 * What a Ree's public figures count since private posts replaced private
 * conversations: the frozen conversation figures (`ree_legacy_stats`,
 * migration 0066) plus the same figures counted from posts, so nothing
 * changes when the conversation tables go (PR B).
 *
 * From posts, a question to a Ree is one of its `post_answer` rows, first
 * round or follow-up, on a published post someone other than its owner
 * asked: the post's author for the first round, the follow-up's for a
 * follow-up. Only real questions count -- `post` (public and private) and
 * `api` (MCP) -- never the owner's 试问 (`test`), RE0's examples, copied
 * Q&A, a visitor's published answer (anonymous answers are counted apart,
 * explore.ts) or a 转为公开 copy, whose answers were already counted on the
 * private post. 有帮助 is `post_answer_vote`, 没帮助 `post_answer_feedback`,
 * both by anyone but the owner.
 *
 * The fragments read the post answer as `a` and its post as `p`.
 */
import { sql, type SQL } from 'drizzle-orm';
import { schema } from '@/lib/infra/db';

const { post, postAnswer, postFollowup, postAnswerVote, postAnswerFeedback, reeLegacyStats } = schema;

/** The post answer `a` on post `p` is a question someone other than `owner` asked (see above). */
export function askedByOthers(owner: SQL): SQL {
  return sql`(p.source in ('post', 'api') and p.status = 'published' and a.legacy_qa_id is null
    and not exists (select 1 from ${post} cp where cp.published_copy_id = p.id)
    and case when a.followup_id is null then p.user_id is distinct from ${owner}
      else exists (select 1 from ${postFollowup} f where f.id = a.followup_id and f.status = 'published' and f.user_id <> ${owner}) end)`;
}

/** The Ree was asked, answered or not (a paid request still waiting for, or refused by, the author was not). */
export const ASKED = sql.raw(`a.state not in ('awaiting', 'declined')`);
/** The Ree answered, and the answer is not hidden. */
export const ANSWERED = sql.raw(`(a.state = 'answered' and a.hidden_by is null)`);

/** Answers to other people, all time: the frozen conversation figure plus the posts'. */
export function answersByOthersOf(reeId: SQL, owner: SQL): SQL<number> {
  return sql<number>`(coalesce((select ls.answers_by_others from ${reeLegacyStats} ls where ls.ree_id = ${reeId}), 0)
    + (select count(*) from ${postAnswer} a join ${post} p on p.id = a.post_id where a.ree_id = ${reeId} and ${ANSWERED} and ${askedByOthers(owner)}))::int`;
}

/** 有帮助 / 没帮助 on the Ree's answers from posts, by anyone but its owner (the owner's 试问 has none to count). */
export function postVotesOf(reeId: SQL, owner: SQL, vote: 'up' | 'down'): SQL<number> {
  const table = vote === 'up' ? postAnswerVote : postAnswerFeedback;
  return sql<number>`(select count(*) from ${table} v join ${postAnswer} a on a.id = v.answer_id join ${post} p on p.id = a.post_id
    where a.ree_id = ${reeId} and a.state = 'answered' and v.user_id <> ${owner} and p.source <> 'test')`;
}

/** Other people's 有帮助 / 没帮助, all time: the frozen conversation votes plus the posts'. */
export function votesByOthersOf(reeId: SQL, owner: SQL, vote: 'up' | 'down'): SQL<number> {
  const legacy = vote === 'up' ? sql.raw('ls.helpful') : sql.raw('ls.unhelpful');
  return sql<number>`(coalesce((select ${legacy} from ${reeLegacyStats} ls where ls.ree_id = ${reeId}), 0) + ${postVotesOf(reeId, owner, vote)})::int`;
}
