-- Leads left on a showcase page: a visitor the library could not answer,
-- with their contact and what they asked. lib/domain/showcase.ts
-- (`validateLead`), lib/application/showcase/leads.ts.
--
-- The one place a visitor's personal data is kept: never in the exchange
-- log, never embedded or grouped. Scoped to the page and its owner; gone
-- with the library.

DO $$ BEGIN
  CREATE TYPE "showcase_lead_status" AS ENUM ('new', 'handled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "showcase_lead" (
  "id" uuid PRIMARY KEY,
  "showcase_id" uuid NOT NULL REFERENCES "library_showcase"("id") ON DELETE CASCADE,
  "library_id" uuid NOT NULL REFERENCES "library"("id"),
  "workspace_id" uuid NOT NULL REFERENCES "workspace"("id"),
  "exchange_id" uuid REFERENCES "widget_exchange"("id") ON DELETE SET NULL,
  "email" text NOT NULL,
  "name" text,
  "message" text,
  "status" "showcase_lead_status" NOT NULL DEFAULT 'new',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "handled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "showcase_lead_showcase_idx" ON "showcase_lead" ("showcase_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "showcase_lead_workspace_new_idx" ON "showcase_lead" ("workspace_id") WHERE "status" = 'new';
--> statement-breakpoint
ALTER TABLE "library_showcase_daily" ADD COLUMN IF NOT EXISTS "leads" integer NOT NULL DEFAULT 0;
