CREATE TABLE "kyc_record" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text DEFAULT 'manual' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"legal_name" text,
	"country" text,
	"document_kind" text,
	"document_last4" text,
	"document_expires" text,
	"tax_form" text,
	"tax_declared_at" timestamp with time zone,
	"consent_at" timestamp with time zone,
	"document_blob" text,
	"selfie_blob" text,
	"files_deleted_at" timestamp with time zone,
	"reason" text,
	"reviewed_by" uuid,
	"decided_at" timestamp with time zone,
	"reset_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kyc_record_provider_check" CHECK (provider in ('manual')),
	CONSTRAINT "kyc_record_status_check" CHECK (status in ('pending', 'verified', 'rejected', 'reset')),
	CONSTRAINT "kyc_record_document_kind_check" CHECK (document_kind is null or document_kind in ('passport', 'id', 'residence')),
	CONSTRAINT "kyc_record_tax_form_check" CHECK (tax_form is null or tax_form in ('W-8BEN', 'W-9')),
	CONSTRAINT "kyc_record_expires_check" CHECK (document_expires is null or document_expires ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
	CONSTRAINT "kyc_record_submission_check" CHECK (status = 'reset' or (legal_name is not null and country is not null and document_kind is not null and document_last4 is not null and document_expires is not null and tax_form is not null and tax_declared_at is not null and consent_at is not null))
);
--> statement-breakpoint
CREATE TABLE "payout" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"credits" bigint NOT NULL,
	"paypal_email" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"hold_id" uuid,
	"kyc_record_id" uuid,
	"review_note" text,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"transfer_id" text,
	"paid_cents" integer,
	"fee_credits" bigint,
	"failure_reason" text,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payout_status_check" CHECK (status in ('pending', 'approved', 'rejected', 'paid', 'failed')),
	CONSTRAINT "payout_credits_check" CHECK (credits > 0),
	CONSTRAINT "payout_paid_check" CHECK ((status = 'paid') = (paid_cents is not null and transfer_id is not null)),
	CONSTRAINT "payout_paid_cents_check" CHECK (paid_cents is null or (paid_cents > 0 and paid_cents::bigint * 100 <= credits)),
	CONSTRAINT "payout_fee_check" CHECK (fee_credits is null or (fee_credits >= 0 and fee_credits = credits - paid_cents::bigint * 100))
);
--> statement-breakpoint
ALTER TABLE "kyc_record" ADD CONSTRAINT "kyc_record_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout" ADD CONSTRAINT "payout_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout" ADD CONSTRAINT "payout_hold_id_credit_hold_id_fk" FOREIGN KEY ("hold_id") REFERENCES "public"."credit_hold"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout" ADD CONSTRAINT "payout_kyc_record_id_kyc_record_id_fk" FOREIGN KEY ("kyc_record_id") REFERENCES "public"."kyc_record"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kyc_record_user_idx" ON "kyc_record" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "kyc_record_status_idx" ON "kyc_record" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "kyc_record_files_idx" ON "kyc_record" USING btree ("created_at") WHERE files_deleted_at is null and (document_blob is not null or selfie_blob is not null);--> statement-breakpoint
CREATE UNIQUE INDEX "payout_open_key" ON "payout" USING btree ("user_id") WHERE status in ('pending', 'approved');--> statement-breakpoint
CREATE INDEX "payout_user_idx" ON "payout" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "payout_status_idx" ON "payout" USING btree ("status","created_at");