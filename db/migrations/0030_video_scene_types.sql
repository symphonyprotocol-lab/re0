ALTER TABLE "ree_video" DROP CONSTRAINT "ree_video_template_check";--> statement-breakpoint
ALTER TABLE "video_export" DROP CONSTRAINT "video_export_template_check";--> statement-breakpoint
ALTER TABLE "ree_video" ALTER COLUMN "template" SET DEFAULT 'product-demo';--> statement-breakpoint
-- The four-shot templates are retired: their videos move to the product demo. One that already
-- holds a generated demo keeps it; the others wait for a new narrated script.
UPDATE "ree_video" SET "template" = 'product-demo', "generated" = "generated" AND "scenes" ? 'demo', "aspect" = '16:9', "revision" = "revision" + 1, "updated_at" = now() WHERE "template" IN ('editorial', 'blueprint', 'spotlight');--> statement-breakpoint
ALTER TABLE "ree_video" ADD CONSTRAINT "ree_video_template_check" CHECK (template in ('product-demo', 'user-manual', 'course-intro', 'article-summary'));--> statement-breakpoint
ALTER TABLE "video_export" ADD CONSTRAINT "video_export_template_check" CHECK (template in ('product-demo', 'user-manual', 'course-intro', 'article-summary', 'editorial', 'blueprint', 'spotlight'));
