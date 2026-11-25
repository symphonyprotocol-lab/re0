-- 0097_mcp_oauth: OAuth 2.1 for the MCP server (docs/mcp.md, lib/services/oauth.ts), so clients that
-- connect only through OAuth (claude.ai custom connectors, ChatGPT) can reach /api/mcp. Clients register
-- themselves or are known by their metadata document's URL (oauth_client); an authorization request waits
-- for the consent page and becomes a one-time code (oauth_authorization); the access a user approves is an
-- api_key row with oauth_client_id and no secret of its own (key_digest null), so every permission, rate
-- limit, tag and usage figure of a key applies to it unchanged; its tokens are kept by digest (oauth_token).
-- Existing keys all have a digest and no client, so the new check holds for every row.
-- Follows 0096_workspace_review_fixes (#258), which must be merged first.
CREATE TABLE "oauth_authorization" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"browser_digest" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"scope" text DEFAULT '' NOT NULL,
	"state" text,
	"resource" text NOT NULL,
	"user_id" uuid,
	"code_digest" text,
	"can_write" boolean DEFAULT false NOT NULL,
	"workspace_access" text DEFAULT 'none' NOT NULL,
	"workspace_only" boolean DEFAULT false NOT NULL,
	"workspace_root" text DEFAULT '/' NOT NULL,
	"api_key_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"used_at" timestamp with time zone,
	CONSTRAINT "oauth_authorization_workspace_access_check" CHECK (workspace_access in ('none', 'read', 'write')),
	CONSTRAINT "oauth_authorization_code_check" CHECK (code_digest is null or user_id is not null)
);
--> statement-breakpoint
CREATE TABLE "oauth_client" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"client_name" text NOT NULL,
	"client_uri" text,
	"redirect_uris" text[] NOT NULL,
	"token_endpoint_auth_method" text DEFAULT 'none' NOT NULL,
	"secret_digest" text,
	"fetched_at" timestamp with time zone,
	"refresh_after" timestamp with time zone,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_client_kind_check" CHECK (kind in ('registered', 'metadata_document')),
	CONSTRAINT "oauth_client_auth_method_check" CHECK (token_endpoint_auth_method in ('none', 'client_secret_post', 'client_secret_basic')),
	CONSTRAINT "oauth_client_secret_check" CHECK ((token_endpoint_auth_method = 'none') = (secret_digest is null)),
	CONSTRAINT "oauth_client_name_check" CHECK (char_length(client_name) between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "oauth_token" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"api_key_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"digest" text NOT NULL,
	"resource" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"rotated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "oauth_token_kind_check" CHECK (kind in ('access', 'refresh'))
);
--> statement-breakpoint
ALTER TABLE "api_key" ALTER COLUMN "key_digest" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "api_key" ADD COLUMN "oauth_client_id" text;--> statement-breakpoint
ALTER TABLE "oauth_authorization" ADD CONSTRAINT "oauth_authorization_client_id_oauth_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_authorization" ADD CONSTRAINT "oauth_authorization_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_authorization" ADD CONSTRAINT "oauth_authorization_api_key_id_api_key_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_key"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_token" ADD CONSTRAINT "oauth_token_api_key_id_api_key_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_key"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_authorization_code_key" ON "oauth_authorization" USING btree ("code_digest");--> statement-breakpoint
CREATE INDEX "oauth_authorization_expires_idx" ON "oauth_authorization" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "oauth_client_last_seen_idx" ON "oauth_client" USING btree ("last_seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_token_digest_key" ON "oauth_token" USING btree ("digest");--> statement-breakpoint
CREATE INDEX "oauth_token_grant_idx" ON "oauth_token" USING btree ("api_key_id","expires_at");--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_oauth_client_id_oauth_client_id_fk" FOREIGN KEY ("oauth_client_id") REFERENCES "public"."oauth_client"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_key_oauth_client_idx" ON "api_key" USING btree ("oauth_client_id") WHERE oauth_client_id is not null;--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_oauth_check" CHECK ((oauth_client_id is null) = (key_digest is not null));