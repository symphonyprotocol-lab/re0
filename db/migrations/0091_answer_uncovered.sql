-- 0091_answer_uncovered: marks an answer in which the Ree says its sources do not cover the
-- question (lib/domain/answer.ts `readsAsUncovered`). It stays an answer -- shown and charged --
-- but the share page never features it (lib/services/posts.ts `reePostPicks`).
ALTER TABLE "post_answer" ADD COLUMN "uncovered" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- Existing answers: the same conservative check new answers get -- a short reply (at most
-- 300 characters) that says outright it cannot answer, or that the question is outside its
-- knowledge. The pattern is UNCOVERED_PATTERN verbatim (tests/unit/answer-uncovered.test.ts).
-- An answer that ended on the no-answer sentinel after a longer reply was never recorded, so
-- only the text can tell for these.
UPDATE "post_answer" SET "uncovered" = true
WHERE "state" = 'answered'
  AND char_length(btrim("text")) BETWEEN 1 AND 300
  AND "text" ~* '(cannot|can ?not|can''t|can’t|unable to|not able to) (answer|provide an answer|be answered)|outside (of )?(my|the) (knowledge|sources)|not (in|within|covered by) (my|the) (knowledge|sources|passages)|无法(回答|作答|解答|给出答案|根据)|不能(回答|作答)|(不在|超出)(我的)?(知识|资料)范围';
