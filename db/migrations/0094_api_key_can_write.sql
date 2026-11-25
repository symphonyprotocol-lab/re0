-- 0094_api_key_can_write: whether an API key may change things through MCP (post, follow up,
-- manage Rees and their knowledge), chosen when the key is made in Settings → API.
-- Every existing key reads 'false': it keeps exactly what it could do before -- search, read
-- and ask_ree -- and gains no write access a leaked key could use.
ALTER TABLE "api_key" ADD COLUMN "can_write" boolean DEFAULT false NOT NULL;
