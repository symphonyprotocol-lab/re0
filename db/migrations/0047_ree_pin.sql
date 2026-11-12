-- Administrators pin Rees to the top of Discover's default order and the
-- home page (lib/services/explore.ts): lower pin_order first, null when not
-- pinned, with who pinned it and when. New nullable columns; no rows change.
ALTER TABLE "ree" ADD COLUMN "pin_order" integer;--> statement-breakpoint
ALTER TABLE "ree" ADD COLUMN "pinned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ree" ADD COLUMN "pinned_by" uuid;--> statement-breakpoint
ALTER TABLE "ree" ADD CONSTRAINT "ree_pin_order_check" CHECK (pin_order is null or pin_order between 1 and 999);