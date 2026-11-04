ALTER TABLE "firecrawl_key" ADD COLUMN "is_fallback" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Preserve the existing main account's role; duplicate names resolve deterministically.
UPDATE "firecrawl_key" SET "is_fallback" = true
WHERE "id" = (
  SELECT "id" FROM "firecrawl_key" WHERE btrim("name") = '主账号'
  ORDER BY "created_at", "id" LIMIT 1
);--> statement-breakpoint
CREATE UNIQUE INDEX "firecrawl_key_fallback_key" ON "firecrawl_key" USING btree ("is_fallback") WHERE "firecrawl_key"."is_fallback" = true;
