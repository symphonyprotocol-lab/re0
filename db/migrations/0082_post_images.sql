-- Images on posts (lib/domain/post-images.ts): post_image rows (private Blob objects under the author's prefix), post.image_text (the generation model's OCR + description, read by matching and retrieval),
-- and model_config.supports_images: an OpenAI-compatible generation entry the operator marks as reading images (a gateway entry's comes from the gateway catalog's vision tag).
CREATE TABLE "post_image" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"post_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"pathname" text NOT NULL,
	"content_type" text NOT NULL,
	"bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "post_image_position_check" CHECK (position between 0 and 3),
	CONSTRAINT "post_image_content_type_check" CHECK (content_type in ('image/jpeg', 'image/png', 'image/webp'))
);
--> statement-breakpoint
ALTER TABLE "model_config" ADD COLUMN "supports_images" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "post" ADD COLUMN "image_text" text;--> statement-breakpoint
ALTER TABLE "post_image" ADD CONSTRAINT "post_image_post_id_post_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."post"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "post_image_position_key" ON "post_image" USING btree ("post_id","position");--> statement-breakpoint
CREATE INDEX "post_image_pathname_idx" ON "post_image" USING btree ("pathname");
