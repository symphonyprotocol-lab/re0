ALTER TABLE "ree_video" DROP CONSTRAINT "ree_video_template_check";--> statement-breakpoint
ALTER TABLE "video_export" DROP CONSTRAINT "video_export_template_check";--> statement-breakpoint
ALTER TABLE "ree_video" ADD CONSTRAINT "ree_video_template_check" CHECK (template in ('editorial', 'blueprint', 'spotlight', 'product-demo'));--> statement-breakpoint
ALTER TABLE "video_export" ADD CONSTRAINT "video_export_template_check" CHECK (template in ('editorial', 'blueprint', 'spotlight', 'product-demo'));