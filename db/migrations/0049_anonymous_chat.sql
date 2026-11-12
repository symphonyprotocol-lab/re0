CREATE TABLE "anonymous_answer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ree_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "anonymous_chat_quota" (
	"key_hash" text NOT NULL,
	"day" date NOT NULL,
	"rounds" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "anonymous_chat_quota_key_hash_day_pk" PRIMARY KEY("key_hash","day"),
	CONSTRAINT "anonymous_chat_quota_rounds_check" CHECK (rounds >= 0)
);
--> statement-breakpoint
ALTER TABLE "anonymous_answer" ADD CONSTRAINT "anonymous_answer_ree_id_ree_id_fk" FOREIGN KEY ("ree_id") REFERENCES "public"."ree"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "anonymous_answer_ree_idx" ON "anonymous_answer" USING btree ("ree_id","created_at");--> statement-breakpoint
CREATE INDEX "anonymous_chat_quota_day_idx" ON "anonymous_chat_quota" USING btree ("day");