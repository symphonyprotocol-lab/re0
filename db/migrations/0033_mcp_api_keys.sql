CREATE TABLE "api_key" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"key_digest" text NOT NULL,
	"key_tail" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_key_name_check" CHECK (char_length(name) between 1 and 60)
);
--> statement-breakpoint
ALTER TABLE "conversation" DROP CONSTRAINT "conversation_kind_check";--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "api_key_id" uuid;--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_key_digest_key" ON "api_key" USING btree ("key_digest");--> statement-breakpoint
CREATE INDEX "api_key_user_idx" ON "api_key" USING btree ("user_id","created_at");--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_api_key_id_api_key_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_key"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_api_key_idx" ON "message" USING btree ("api_key_id","created_at") WHERE api_key_id is not null;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_kind_check" CHECK (kind in ('normal', 'ree_test', 'mcp'));