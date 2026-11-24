-- Adds the travel and literature Ree categories (lib/constants.ts REE_CATEGORIES).
-- Existing official Rees move into them by hand with scripts/recategorise-official-rees.mts; nothing is moved here.
ALTER TABLE "ree" DROP CONSTRAINT "ree_category_check";--> statement-breakpoint
ALTER TABLE "ree" ADD CONSTRAINT "ree_category_check" CHECK (category in ('technology', 'design', 'business', 'learning', 'professional', 'life', 'travel', 'literature', 'other'));
