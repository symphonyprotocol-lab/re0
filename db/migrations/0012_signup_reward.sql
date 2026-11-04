CREATE TABLE "signup_reward" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"credits" integer NOT NULL,
	"revision" uuid DEFAULT gen_random_uuid() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signup_reward_singleton_check" CHECK (id = 1),
	CONSTRAINT "signup_reward_credits_check" CHECK (credits between 0 and 100000000)
);
--> statement-breakpoint
ALTER TABLE "signup_reward" ADD CONSTRAINT "signup_reward_updated_by_administrator_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."administrator"("id") ON DELETE no action ON UPDATE no action;