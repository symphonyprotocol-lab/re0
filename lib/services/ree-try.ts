/**
 * 试问 (`/rees/[id]/chat`): a Ree's owner tries it against its own knowledge.
 * Each question is a private post (`source = 'test'`) asked of that one Ree
 * -- what the test conversation (`conversation.kind = ree_test`) was -- and,
 * like it, costs the base fee when the Ree answers (no query fee on one's own
 * Ree) and counts nowhere: not in 我的帖子, the Ree's figures, the ranking or
 * the role threshold (ree-counts.ts). The ledger keeps the usage when the
 * owner clears them.
 */
import { and, eq, sql } from 'drizzle-orm';
import { QUERY_BASE_FEE } from '@/lib/constants';
import { isUuid } from '@/lib/domain/list';
import type { PostView } from '@/lib/domain/post';
import { db, schema } from '@/lib/infra/db';
import { reeTryPosts } from '@/lib/services/posts';
import { publishPrivatePost, type PrivatePublishOutcome } from '@/lib/services/private-posts';
import { ownedRee } from '@/lib/services/rees';

/** How many of the latest 试问 the page shows. */
export const REE_TRY_LIST = 30;

export interface ReeTryInput {
  question: string;
  detail?: string;
  lang: 'zh' | 'en';
  clientToken?: string | null;
}

/** The owner asks their own live Ree; null when it is not theirs. Answered by `processPrivatePost` after the response. */
export async function askReeTry(userId: string, reeId: string, input: ReeTryInput, now = new Date()): Promise<PrivatePublishOutcome | null> {
  const ree = await ownedRee(db(), userId, reeId);
  if (!ree) return null;
  return publishPrivatePost(
    userId,
    { question: input.question, detail: input.detail, reeIds: [ree.id], fees: { [ree.id]: QUERY_BASE_FEE }, lang: input.lang, clientToken: input.clientToken },
    { source: 'test', now },
  );
}

/** The owner's latest 试问 of their Ree; null when it is not theirs. */
export async function listReeTries(userId: string, reeId: string): Promise<PostView[] | null> {
  const ree = await ownedRee(db(), userId, reeId);
  if (!ree) return null;
  return reeTryPosts(userId, ree.id, REE_TRY_LIST);
}

/**
 * "清空": deletes the owner's 试问 of their Ree for good, as clearing the test
 * conversation deleted its messages (the ledger keeps what they cost). One
 * still being answered stays until it is done -- its holds settle with it.
 * Null when the Ree is not theirs; else how many went.
 */
export async function clearReeTries(userId: string, reeId: string): Promise<number | null> {
  if (!isUuid(reeId)) return null;
  const ree = await ownedRee(db(), userId, reeId);
  if (!ree) return null;
  const { post, postAnswer } = schema;
  const gone = await db()
    .delete(post)
    .where(
      and(
        eq(post.userId, userId),
        eq(post.source, 'test'),
        eq(post.answerState, 'done'),
        /* Spelled out: a one-table delete leaves its own columns unqualified, which the subqueries would read as theirs. */
        sql`exists (select 1 from ${postAnswer} ta where ta.post_id = "post"."id" and ta.ree_id = ${ree.id})`,
        sql`not exists (select 1 from ${schema.postFollowup} tf where tf.post_id = "post"."id" and tf.answer_state <> 'done')`,
      ),
    )
    .returning({ id: post.id });
  return gone.length;
}
