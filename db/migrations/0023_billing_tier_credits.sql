-- Prices saved before this migration use the current product allowance until an admin sets one.
ALTER TABLE "billing_price" ADD COLUMN "credits" integer;--> statement-breakpoint
-- Before tier allowances were configurable, both products quoted 100,000 credits per unit.
ALTER TABLE "paddle_checkout" ADD COLUMN "unit_credits" integer DEFAULT 100000 NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_price" ADD CONSTRAINT "billing_price_credits_check" CHECK (credits between 1 and 100000000);
