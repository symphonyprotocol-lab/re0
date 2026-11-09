CREATE TABLE "paddle_checkout" (
	"paddle_transaction_id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"quantity" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paddle_checkout_kind_check" CHECK (kind in ('plan', 'pack'))
);
--> statement-breakpoint
ALTER TABLE "purchase" DROP CONSTRAINT "purchase_quantity_check";--> statement-breakpoint
ALTER TABLE "paddle_checkout" ADD CONSTRAINT "paddle_checkout_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "paddle_checkout_user_idx" ON "paddle_checkout" USING btree ("user_id","kind","created_at");--> statement-breakpoint
ALTER TABLE "purchase" ADD CONSTRAINT "purchase_quantity_check" CHECK (quantity >= 1);