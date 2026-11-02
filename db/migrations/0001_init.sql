-- Rebuild baseline (rebuild-proposal.md 4, step 1). pgvector backs chunk.embedding.
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "admin_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"administrator_id" uuid,
	"action" text NOT NULL,
	"target" text,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_session" (
	"id" text PRIMARY KEY NOT NULL,
	"administrator_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "administrator" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'administrator' NOT NULL,
	"password_hash" text NOT NULL,
	"totp_secret_cipher" text NOT NULL,
	"totp_last_counter" bigint,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "administrator_role_check" CHECK (role in ('owner', 'administrator'))
);
--> statement-breakpoint
CREATE TABLE "chunk" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"knowledge_id" uuid NOT NULL,
	"ree_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"locator" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text DEFAULT 'normal' NOT NULL,
	"ree_id" uuid,
	"title" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_kind_check" CHECK (kind in ('normal', 'ree_test')),
	CONSTRAINT "conversation_ree_test_check" CHECK ((kind = 'ree_test') = (ree_id is not null))
);
--> statement-breakpoint
CREATE TABLE "conversation_ree" (
	"conversation_id" uuid NOT NULL,
	"ree_id" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_ree_conversation_id_ree_id_pk" PRIMARY KEY("conversation_id","ree_id")
);
--> statement-breakpoint
CREATE TABLE "credit_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"delta" bigint NOT NULL,
	"reason" text NOT NULL,
	"ref_id" uuid,
	"ree_id" uuid,
	"note" text,
	"allocations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_entry_reason_check" CHECK (reason in ('welcome', 'knowledge_hold', 'knowledge_settle', 'knowledge_refund', 'query_hold', 'query_base', 'query_refund', 'query_fee_paid', 'query_fee_earned', 'purchase', 'refund', 'expire', 'payout_hold', 'payout_release', 'payout_paid', 'video_script', 'video_export', 'admin_adjust'))
);
--> statement-breakpoint
CREATE TABLE "credit_grant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source" text NOT NULL,
	"amount" bigint NOT NULL,
	"remaining" bigint NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_grant_source_check" CHECK (source in ('welcome', 'plan', 'pack', 'earned')),
	CONSTRAINT "credit_grant_remaining_check" CHECK (remaining >= 0 and remaining <= amount)
);
--> statement-breakpoint
CREATE TABLE "credit_hold" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount" bigint NOT NULL,
	"allocations" jsonb NOT NULL,
	"status" text DEFAULT 'held' NOT NULL,
	"ref_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "credit_hold_kind_check" CHECK (kind in ('chat', 'knowledge', 'video', 'payout')),
	CONSTRAINT "credit_hold_status_check" CHECK (status in ('held', 'settled', 'released'))
);
--> statement-breakpoint
CREATE TABLE "knowledge" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ree_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"original_title" text NOT NULL,
	"source" text,
	"file_name" text,
	"file_size" bigint,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"content" text,
	"activity" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_kind_check" CHECK (kind in ('document', 'audio', 'github', 'page', 'site', 'text')),
	CONSTRAINT "knowledge_status_check" CHECK (status in ('pending', 'processing', 'ready', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" text NOT NULL,
	"ree_id" uuid,
	"content" text NOT NULL,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"no_answer" boolean DEFAULT false NOT NULL,
	"no_answer_reason" text,
	"request_id" uuid,
	"cost_credits" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_role_check" CHECK (role in ('user', 'ree')),
	CONSTRAINT "message_no_answer_reason_check" CHECK (no_answer_reason is null or no_answer_reason in ('no_sources', 'out_of_scope'))
);
--> statement-breakpoint
CREATE TABLE "model_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"transport" text NOT NULL,
	"base_url" text,
	"model" text NOT NULL,
	"api_key_cipher" text,
	"api_key_tail" text,
	"timeout_ms" integer DEFAULT 60000 NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"last_probe_at" timestamp with time zone,
	"last_probe_ok" boolean,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_config_kind_check" CHECK (kind in ('generation', 'embedding', 'transcription')),
	CONSTRAINT "model_config_transport_check" CHECK (transport in ('gateway', 'openai_compatible')),
	CONSTRAINT "model_config_base_url_check" CHECK ((transport = 'openai_compatible') = (base_url is not null))
);
--> statement-breakpoint
CREATE TABLE "ree" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"avatar_blob" text,
	"color" text DEFAULT 'default' NOT NULL,
	"category" text DEFAULT 'other' NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"system_prompt" text DEFAULT '' NOT NULL,
	"sample_questions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"query_fee" integer DEFAULT 0 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ree_color_check" CHECK (color in ('default', 'lilac', 'sand', 'sage', 'rose', 'slate')),
	CONSTRAINT "ree_category_check" CHECK (category in ('technology', 'design', 'business', 'learning', 'professional', 'life', 'other')),
	CONSTRAINT "ree_query_fee_check" CHECK (query_fee between 0 and 10000),
	CONSTRAINT "ree_tags_check" CHECK (cardinality(tags) <= 3)
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"avatar_blob" text,
	"lang" text DEFAULT 'zh' NOT NULL,
	"provider" text NOT NULL,
	"provider_subject" text NOT NULL,
	"provider_handle" text,
	"last_login_at" timestamp with time zone,
	"role" text DEFAULT 'normal' NOT NULL,
	"role_changed_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"paypal_email" text,
	"paypal_email_changed_at" timestamp with time zone,
	"ree_draft" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_lang_check" CHECK (lang in ('zh', 'en')),
	CONSTRAINT "user_provider_check" CHECK (provider in ('google', 'github')),
	CONSTRAINT "user_role_check" CHECK (role in ('normal', 'verified', 'official'))
);
--> statement-breakpoint
ALTER TABLE "admin_session" ADD CONSTRAINT "admin_session_administrator_id_administrator_id_fk" FOREIGN KEY ("administrator_id") REFERENCES "public"."administrator"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunk" ADD CONSTRAINT "chunk_knowledge_id_knowledge_id_fk" FOREIGN KEY ("knowledge_id") REFERENCES "public"."knowledge"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_ree_id_ree_id_fk" FOREIGN KEY ("ree_id") REFERENCES "public"."ree"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_ree" ADD CONSTRAINT "conversation_ree_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_ree" ADD CONSTRAINT "conversation_ree_ree_id_ree_id_fk" FOREIGN KEY ("ree_id") REFERENCES "public"."ree"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_entry" ADD CONSTRAINT "credit_entry_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_grant" ADD CONSTRAINT "credit_grant_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_hold" ADD CONSTRAINT "credit_hold_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge" ADD CONSTRAINT "knowledge_ree_id_ree_id_fk" FOREIGN KEY ("ree_id") REFERENCES "public"."ree"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_ree_id_ree_id_fk" FOREIGN KEY ("ree_id") REFERENCES "public"."ree"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ree" ADD CONSTRAINT "ree_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_audit_time_idx" ON "admin_audit" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "admin_audit_action_idx" ON "admin_audit" USING btree ("action");--> statement-breakpoint
CREATE INDEX "admin_session_administrator_idx" ON "admin_session" USING btree ("administrator_id");--> statement-breakpoint
CREATE UNIQUE INDEX "administrator_email_key" ON "administrator" USING btree ("email");--> statement-breakpoint
CREATE INDEX "chunk_knowledge_idx" ON "chunk" USING btree ("knowledge_id","ordinal");--> statement-breakpoint
CREATE INDEX "chunk_ree_idx" ON "chunk" USING btree ("ree_id");--> statement-breakpoint
CREATE INDEX "chunk_embedding_idx" ON "chunk" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "conversation_user_idx" ON "conversation" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_ree_test_key" ON "conversation" USING btree ("user_id","ree_id") WHERE kind = 'ree_test';--> statement-breakpoint
CREATE INDEX "credit_entry_user_idx" ON "credit_entry" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "credit_entry_ref_idx" ON "credit_entry" USING btree ("ref_id");--> statement-breakpoint
CREATE INDEX "credit_grant_user_idx" ON "credit_grant" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "credit_hold_user_idx" ON "credit_hold" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "credit_hold_ref_idx" ON "credit_hold" USING btree ("ref_id");--> statement-breakpoint
CREATE INDEX "knowledge_ree_idx" ON "knowledge" USING btree ("ree_id","updated_at");--> statement-breakpoint
CREATE INDEX "message_conversation_idx" ON "message" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "model_config_one_enabled_key" ON "model_config" USING btree ("kind") WHERE enabled;--> statement-breakpoint
CREATE UNIQUE INDEX "ree_slug_key" ON "ree" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "ree_owner_idx" ON "ree" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE INDEX "session_user_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_provider_subject_key" ON "user" USING btree ("provider","provider_subject");