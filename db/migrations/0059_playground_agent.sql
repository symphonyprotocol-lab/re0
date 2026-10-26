-- The playground's agent mode becomes retrieval configuration (2026-10-26).
-- playground-agent-proposal.md, architecture.md 9.5.
--
-- A model that declares tool calling may plan the playground's searches
-- itself: resolve-library-id and query-docs as tools, then the same bound
-- answer as before. The switch and the planner's three caps join the other
-- retrieval knobs, so turning them is a console save and lands in the audit
-- chain like any other. Existing rows take the defaults: off, 4 steps,
-- 3 reads, 2 resolves.

ALTER TABLE "retrieval_config" ADD COLUMN IF NOT EXISTS "playground_agent" integer DEFAULT 0 NOT NULL;
ALTER TABLE "retrieval_config" ADD COLUMN IF NOT EXISTS "playground_agent_steps" integer DEFAULT 4 NOT NULL;
ALTER TABLE "retrieval_config" ADD COLUMN IF NOT EXISTS "playground_agent_queries" integer DEFAULT 3 NOT NULL;
ALTER TABLE "retrieval_config" ADD COLUMN IF NOT EXISTS "playground_agent_resolves" integer DEFAULT 2 NOT NULL;
