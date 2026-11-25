-- 0092_share_style: how the share page `/s/[slug]` lays a Ree out (lib/domain/share-style.ts).
-- Every Ree stays on 'default', the share page as it is; the owner may pick 'product' in the
-- Ree's settings, which lays it out as a product sheet from the fields they type into
-- "product_sheet" (the product's name, what it is, who makes it, its link, features and specs).
-- Additive: existing rows read '{}' -- an empty sheet -- and the default style.
ALTER TABLE "ree" ADD COLUMN "share_style" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "ree" ADD COLUMN "product_sheet" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ree" ADD CONSTRAINT "ree_share_style_check" CHECK (share_style in ('default', 'product'));
