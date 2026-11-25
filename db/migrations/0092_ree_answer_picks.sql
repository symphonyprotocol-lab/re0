-- 0092_ree_answer_picks: a Ree page's answered questions (lib/services/posts.ts
-- `reeAnsweredExamples`) read the unpinned picks in their order -- most helpful, newest -- so a
-- page with thousands of answers reads three rows instead of sorting them all. The pinned
-- answer comes from post_answer_pinned_key.
CREATE INDEX "post_answer_ree_pick_idx" ON "post_answer" USING btree ("ree_id","helpful_count" DESC NULLS LAST,"answered_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE state = 'answered' and hidden_by is null and followup_id is null and uncovered = false and pinned_at is null;
