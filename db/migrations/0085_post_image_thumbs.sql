-- The feed's small copy of a post image (lib/domain/post-images.ts): the composer uploads it beside the image as <image>.thumb.jpg;
-- null for older posts and when none was made, and /media then serves the image itself. Indexed for the orphan-upload reaper.
ALTER TABLE "post_image" ADD COLUMN "thumb_pathname" text;--> statement-breakpoint
CREATE INDEX "post_image_thumb_pathname_idx" ON "post_image" USING btree ("thumb_pathname");