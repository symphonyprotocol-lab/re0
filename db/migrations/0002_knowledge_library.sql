CREATE TABLE "domain_claim" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"method" text,
	"challenge" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"verified_at" timestamp with time zone,
	"checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "domain_claim_method_check" CHECK (method is null or method in ('dns_txt', 'well_known')),
	CONSTRAINT "domain_claim_status_check" CHECK (status in ('pending', 'verified', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "github_connection" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"github_login" text NOT NULL,
	"encrypted_token" text NOT NULL,
	"scope" text DEFAULT '' NOT NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_folder" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ree_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_folder_name_check" CHECK (char_length(name) between 1 and 40)
);
--> statement-breakpoint
ALTER TABLE "knowledge" ADD COLUMN "folder_id" uuid;--> statement-breakpoint
ALTER TABLE "knowledge" ADD COLUMN "enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge" ADD COLUMN "children" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge" ADD COLUMN "consent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "knowledge" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "domain_claim" ADD CONSTRAINT "domain_claim_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_connection" ADD CONSTRAINT "github_connection_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_folder" ADD CONSTRAINT "knowledge_folder_ree_id_ree_id_fk" FOREIGN KEY ("ree_id") REFERENCES "public"."ree"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "domain_claim_user_domain_key" ON "domain_claim" USING btree ("user_id","domain");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_folder_name_key" ON "knowledge_folder" USING btree ("ree_id",lower("name"));--> statement-breakpoint
ALTER TABLE "knowledge" ADD CONSTRAINT "knowledge_folder_id_knowledge_folder_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."knowledge_folder"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_folder_idx" ON "knowledge" USING btree ("folder_id");--> statement-breakpoint
CREATE INDEX "knowledge_trash_idx" ON "knowledge" USING btree ("deleted_at") WHERE deleted_at is not null;