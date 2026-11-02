import { drizzle } from 'drizzle-orm/neon-serverless';
import { neonConfig, Pool } from '@neondatabase/serverless';
import * as schema from '@/db/schema';

/*
 * Local development against a plain Postgres (a Docker pgvector container
 * behind tests/fixtures/wsproxy.mjs) instead of Neon: set DATABASE_WS_PROXY
 * to the proxy's `host:port/v2`. Ignored in production builds.
 */
const wsProxy = process.env.NODE_ENV !== 'production' ? process.env.DATABASE_WS_PROXY : undefined;
if (wsProxy) {
  neonConfig.wsProxy = () => wsProxy;
  neonConfig.useSecureWebSocket = false;
  neonConfig.pipelineTLS = false;
  neonConfig.pipelineConnect = false;
}

/**
 * The only place a database driver is constructed: Neon over WebSockets, so
 * interactive transactions work (the credit ledger needs them). Locally the
 * integration tests point the same driver at a container through
 * tests/fixtures/local-postgres.ts.
 */
let pool: Pool | undefined;

export function db() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  pool ??= new Pool({ connectionString: url });
  return drizzle(pool, { schema });
}

export type Database = ReturnType<typeof db>;
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
export type Executor = Database | Tx;
export { schema };
