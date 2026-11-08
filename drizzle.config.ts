import { defineConfig } from 'drizzle-kit';
import { loadEnvConfig } from '@next/env';

/**
 * drizzle-kit runs outside Next, so nothing has read `.env.local` yet. Using
 * Next's own loader keeps the CLI and the app on identical env resolution --
 * the alternative, a second dotenv setup, drifts the moment the two disagree
 * about precedence.
 */
loadEnvConfig(process.cwd());

/*
 * The local Docker database (docker-compose.yml) is a plain Postgres behind
 * tests/fixtures/wsproxy.mjs, and drizzle-kit migrates through the Neon
 * WebSocket driver, so it needs the same proxy hook lib/infra/db.ts sets.
 * drizzle-kit loads the driver with a dynamic import(), which is the ESM
 * build -- a separate module instance from the CommonJS one a static import
 * here would configure -- so this configures it the same way. The callback
 * runs as soon as the module loads, before drizzle-kit opens a connection.
 * Never on Vercel or in production.
 */
const wsProxy =
  process.env.NODE_ENV !== 'production' && !process.env.VERCEL ? process.env.DATABASE_WS_PROXY : undefined;
if (wsProxy) {
  void import('@neondatabase/serverless').then(({ neonConfig }) => {
    neonConfig.wsProxy = () => wsProxy;
    neonConfig.useSecureWebSocket = false;
    neonConfig.pipelineTLS = false;
    neonConfig.pipelineConnect = false;
  });
}

export default defineConfig({
  schema: './db/schema.ts',
  out: './db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    // Migrations run through the unpooled endpoint, see architecture.md 19.1
    url: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? '',
  },
  strict: true,
  verbose: true,
});
