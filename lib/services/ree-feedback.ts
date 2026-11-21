import { sql } from 'drizzle-orm';
import { votesByOthersOf } from '@/lib/services/ree-counts';

/** Card feedback excludes the owner's own votes in both discovery and My Rees: the conversations' frozen votes plus the posts' (ree-counts.ts). */
export const votesByOthers = (vote: 'up' | 'down') => votesByOthersOf(sql.raw('"ree"."id"'), sql.raw('"ree"."owner_id"'), vote);
