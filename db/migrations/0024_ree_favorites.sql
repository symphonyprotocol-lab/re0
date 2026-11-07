CREATE TABLE "ree_favorite" (
	"user_id" uuid NOT NULL,
	"ree_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ree_favorite_user_id_ree_id_pk" PRIMARY KEY("user_id","ree_id")
);
--> statement-breakpoint
ALTER TABLE "ree_favorite" ADD CONSTRAINT "ree_favorite_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ree_favorite" ADD CONSTRAINT "ree_favorite_ree_id_ree_id_fk" FOREIGN KEY ("ree_id") REFERENCES "public"."ree"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ree_favorite_recent_idx" ON "ree_favorite" USING btree ("user_id","created_at" DESC NULLS LAST,"ree_id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ree_favorite_ree_idx" ON "ree_favorite" USING btree ("ree_id");