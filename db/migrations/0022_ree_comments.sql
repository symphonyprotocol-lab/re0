CREATE TABLE "ree_comment" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ree_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ree_comment_content_check" CHECK (char_length(content) between 1 and 500)
);
--> statement-breakpoint
ALTER TABLE "ree_comment" ADD CONSTRAINT "ree_comment_ree_id_ree_id_fk" FOREIGN KEY ("ree_id") REFERENCES "public"."ree"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ree_comment" ADD CONSTRAINT "ree_comment_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ree_comment_recent_idx" ON "ree_comment" USING btree ("ree_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ree_comment_user_idx" ON "ree_comment" USING btree ("user_id");