-- Agent-first turn, phase P2 (agent-first-proposal.md 4.4, 5.1, 5.2, 7.2, 7.6, 7.8, 8.2, 12, 13.1; 2026-10-30).
--
-- The workbench gets conversations, the Agent's side effects get a pending
-- action table that only the signed-in owner can move out of `pending`, A2A
-- tasks get push-notification configs, and the console gets the two `ask`
-- metering values (10 Calls per answer, 500 answers per workspace per day).
-- `assets:write` is a new value of `api_key.scopes` (jsonb), which needs no
-- DDL.
--
-- Written for the integration runner, which feeds each statement to psql in
-- autocommit mode: no BEGIN, no temp tables.

-- ------------------------------------------------------------ ask metering
ALTER TABLE "retrieval_config" ADD COLUMN "ask_calls_per_answer" integer NOT NULL DEFAULT 10;
--> statement-breakpoint
ALTER TABLE "retrieval_config" ADD COLUMN "ask_daily_answers" integer NOT NULL DEFAULT 500;
--> statement-breakpoint

-- ---------------------------------------------------------- conversations
CREATE TABLE "agent_conversation" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspace"("id") ON DELETE CASCADE,
  "created_by" uuid REFERENCES "user"("id") ON DELETE SET NULL,
  "title" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "agent_conversation_workspace_idx" ON "agent_conversation" ("workspace_id", "updated_at" DESC);
--> statement-breakpoint
CREATE TABLE "agent_message" (
  "id" uuid PRIMARY KEY,
  "conversation_id" uuid NOT NULL REFERENCES "agent_conversation"("id") ON DELETE CASCADE,
  "role" text NOT NULL,
  "content" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "agent_message_conversation_idx" ON "agent_message" ("conversation_id", "created_at");
--> statement-breakpoint

-- -------------------------------------------------------- pending actions
-- Proposal 5.2: one-shot, bound to the exact parameters, 24 hours, and only
-- the owner confirms. The table holds the facts; the conditional update in
-- lib/application/agent/actions.ts is the gate.
CREATE TABLE "agent_action" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspace"("id") ON DELETE CASCADE,
  "tool" text NOT NULL,
  "params" jsonb NOT NULL,
  "params_digest" text NOT NULL,
  "summary" jsonb NOT NULL,
  "estimated_calls" integer NOT NULL DEFAULT 0,
  "estimated_bytes" bigint,
  "makes_public" boolean NOT NULL DEFAULT false,
  "state" text NOT NULL DEFAULT 'pending',
  "origin" text NOT NULL,
  "requested_by" uuid REFERENCES "user"("id") ON DELETE SET NULL,
  "api_key_id" uuid,
  "conversation_id" uuid REFERENCES "agent_conversation"("id") ON DELETE SET NULL,
  "a2a_task_id" text REFERENCES "a2a_task"("id") ON DELETE SET NULL,
  "confirmed_by" uuid REFERENCES "user"("id") ON DELETE SET NULL,
  "decided_at" timestamp with time zone,
  "result" jsonb,
  "error" text,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "agent_action_state_check" CHECK ("state" IN ('pending', 'confirmed', 'failed', 'rejected', 'expired'))
);
--> statement-breakpoint
CREATE INDEX "agent_action_workspace_idx" ON "agent_action" ("workspace_id", "state", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX "agent_action_task_idx" ON "agent_action" ("a2a_task_id");
--> statement-breakpoint
CREATE INDEX "agent_action_expiry_idx" ON "agent_action" ("expires_at") WHERE "state" = 'pending';
--> statement-breakpoint

-- ------------------------------------------------- A2A push notifications
CREATE TABLE "a2a_push_config" (
  "id" text NOT NULL,
  "task_id" text NOT NULL REFERENCES "a2a_task"("id") ON DELETE CASCADE,
  "workspace_id" uuid REFERENCES "workspace"("id") ON DELETE CASCADE,
  "tenant" text NOT NULL DEFAULT '',
  "url" text NOT NULL,
  "secret" text,
  "wire_version" text NOT NULL DEFAULT '1.0',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("task_id", "id")
);
