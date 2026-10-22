-- A showcase page on the owner's own subdomain. lib/domain/showcase.ts
-- (`parseCustomHost`), lib/application/showcase/domain.ts.
--
-- Ownership is proved first, through the same TXT challenge a website
-- library's source goes through, and only then is the host added to the
-- deployment's Vercel project. The challenge token is kept here, in the
-- clear, because the owner must be shown the record on every visit until
-- it resolves; it proves control of this host for this page and nothing
-- else. One host per page, one page per host.

DO $$ BEGIN
  CREATE TYPE "showcase_domain_status" AS ENUM ('pending_ownership', 'pending_dns', 'ready', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "showcase_domain" (
  "id" uuid PRIMARY KEY,
  "showcase_id" uuid NOT NULL REFERENCES "library_showcase"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspace"("id"),
  "host" text NOT NULL,
  "status" "showcase_domain_status" NOT NULL DEFAULT 'pending_ownership',
  "verification_id" uuid REFERENCES "domain_verification"("id") ON DELETE SET NULL,
  "verification_token" text,
  "vercel_txt_name" text,
  "vercel_txt_value" text,
  "last_checked_at" timestamp with time zone,
  "error" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "showcase_domain_showcase_uq" ON "showcase_domain" ("showcase_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "showcase_domain_host_uq" ON "showcase_domain" ("host");
