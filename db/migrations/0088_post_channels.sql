CREATE TABLE "channel" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_name_check" CHECK (char_length(name) between 1 and 32)
);
--> statement-breakpoint
CREATE TABLE "post_channel" (
	"post_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "post_channel_post_id_channel_id_pk" PRIMARY KEY("post_id","channel_id")
);
--> statement-breakpoint
ALTER TABLE "channel" ADD CONSTRAINT "channel_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_channel" ADD CONSTRAINT "post_channel_post_id_post_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."post"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_channel" ADD CONSTRAINT "post_channel_channel_id_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_name_key" ON "channel" USING btree ("name");--> statement-breakpoint
CREATE INDEX "channel_name_search_idx" ON "channel" USING gin (name gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "post_channel_channel_idx" ON "post_channel" USING btree ("channel_id","post_id");