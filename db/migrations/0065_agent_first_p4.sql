-- Agent-first turn, phase P4 (agent-first-proposal.md 2.2, 4.2, 7.9, 10, 13.1; 2026-10-30).
--
-- re0 becomes an A2A client: a workspace registers external Agents by their
-- Agent Card, stores one sealed credential per Agent, and the workbench's
-- `delegate_task` -- confirmed by the owner like every other action -- sends
-- a sub-task whose remote task is tracked in `agent_delegation`. Workspaces
-- get a retention setting for private assets. `for` joins the reserved names
-- (the scenario pages live at /for/{scenario}).
--
-- Written for the integration runner, which feeds each statement to psql in
-- autocommit mode: no BEGIN, no temp tables.

-- --------------------------------------------------------- reserved names
-- A workspace that already took `for` as its handle gets `user-` plus a
-- digest, the fallback 0062 and 0064 used.
UPDATE "workspace" SET "handle" = 'user-' || substr(md5("id"::text), 1, 6)
  WHERE "handle" IN ('for');
--> statement-breakpoint

-- ------------------------------------------------- private asset retention
ALTER TABLE "workspace" ADD COLUMN "private_asset_retention_days" integer;
--> statement-breakpoint
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_private_asset_retention_ck"
  CHECK ("private_asset_retention_days" IS NULL OR "private_asset_retention_days" IN (30, 90, 180, 365));
--> statement-breakpoint

-- ---------------------------------------------------------- external agents
CREATE TABLE "external_agent" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspace"("id") ON DELETE CASCADE,
  "created_by" uuid REFERENCES "user"("id") ON DELETE SET NULL,
  "card_url" text NOT NULL,
  "name" text NOT NULL,
  "description" text NOT NULL DEFAULT '',
  "provider_name" text,
  "version" text,
  "endpoints" jsonb NOT NULL,
  "skills" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "security_schemes" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "security_requirements" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "card" jsonb NOT NULL,
  "card_digest" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "fetched_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "external_agent_status_ck" CHECK ("status" IN ('active', 'disabled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "external_agent_card_uq" ON "external_agent" ("workspace_id", "card_url");
--> statement-breakpoint

-- Sealed with CREDENTIAL_ENCRYPTION_KEY (purpose `agent`); only the suffix is
-- ever shown again.
CREATE TABLE "external_agent_credential" (
  "agent_id" uuid PRIMARY KEY REFERENCES "external_agent"("id") ON DELETE CASCADE,
  "id" uuid NOT NULL,
  "kind" text NOT NULL,
  "sealed" text NOT NULL,
  "suffix" text,
  "version" integer NOT NULL DEFAULT 1,
  "updated_by" uuid REFERENCES "user"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "external_agent_credential_kind_ck" CHECK ("kind" IN ('bearer', 'api_key'))
);
--> statement-breakpoint

-- ------------------------------------------------------------- delegations
CREATE TABLE "agent_delegation" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspace"("id") ON DELETE CASCADE,
  "action_id" uuid REFERENCES "agent_action"("id") ON DELETE SET NULL,
  "agent_id" uuid REFERENCES "external_agent"("id") ON DELETE SET NULL,
  "agent_name" text NOT NULL,
  "conversation_id" uuid REFERENCES "agent_conversation"("id") ON DELETE SET NULL,
  "skill" text,
  "endpoint_url" text NOT NULL,
  "remote_task_id" text,
  "remote_context_id" text,
  "state" text NOT NULL,
  "status_message" text,
  "output" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "error" text,
  "body_purge_at" timestamp with time zone NOT NULL,
  "last_polled_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "agent_delegation_workspace_idx" ON "agent_delegation" ("workspace_id", "created_at" DESC);
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_delegation_action_uq" ON "agent_delegation" ("action_id");
--> statement-breakpoint
CREATE INDEX "agent_delegation_purge_idx" ON "agent_delegation" ("body_purge_at");
