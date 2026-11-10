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

/**
 * A pool whose idle clients may be cut off (a Neon compute scaling to zero,
 * a proxy restart). pg emits that as an `error` on the pool; with no listener
 * an EventEmitter `error` is an uncaught exception that takes the whole
 * instance down, every stream on it included. The broken client is already
 * discarded, so logging is all there is to do; the next query opens a new one.
 */
export function createPool(connectionString: string): Pool {
  const created = new Pool({ connectionString });
  created.on('error', (error: Error) => {
    console.error(`database pool: idle client dropped (${error.message})`);
  });
  return created;
}

export function db() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  pool ??= createPool(url);
  return drizzle(pool, { schema });
}

export type Database = ReturnType<typeof db>;
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
export type Executor = Database | Tx;
export { schema };
