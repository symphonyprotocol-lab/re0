import { sql } from 'drizzle-orm';
import { schema } from '@/lib/infra/db';

/** Card feedback excludes the owner's own votes in both discovery and My Rees. */
export const votesByOthers = (vote: 'up' | 'down') =>
  sql<number>`(select count(*)::int from ${schema.reeFeedback} f join ${schema.message} m on m.id = f.message_id where m.ree_id = "ree"."id" and f.vote = ${vote} and f.user_id <> "ree"."owner_id")`;
