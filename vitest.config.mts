import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Unit tests run anywhere; `tests/integration` needs a database and skips
 * itself unless TEST_DATABASE_URL is set (scripts/test-integration.sh sets it
 * to a disposable pgvector container). Integration files share that database,
 * so they run one at a time.
 */
const sharesADatabase = Boolean(process.env.TEST_DATABASE_URL);

export default defineConfig({
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: {
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./tests/fixtures/local-postgres.ts'],
    fileParallelism: !sharesADatabase,
  },
});
