CREATE TABLE "post_ai_answer_report" (
	"ai_answer_id" uuid NOT NULL,
	"reporter_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "post_ai_answer_report_ai_answer_id_reporter_key_pk" PRIMARY KEY("ai_answer_id","reporter_key")
);
--> statement-breakpoint
ALTER TABLE "post" ADD COLUMN "answering_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "post_ai_answer" ADD COLUMN "report_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "post_ai_answer" ADD COLUMN "hidden_by" text;--> statement-breakpoint
ALTER TABLE "post_followup" ADD COLUMN "answering_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "post_ai_answer_report" ADD CONSTRAINT "post_ai_answer_report_ai_answer_id_post_ai_answer_id_fk" FOREIGN KEY ("ai_answer_id") REFERENCES "public"."post_ai_answer"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_ai_answer" ADD CONSTRAINT "post_ai_answer_hidden_by_check" CHECK (hidden_by is null or hidden_by in ('reports', 'admin'));
