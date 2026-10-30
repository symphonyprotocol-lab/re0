import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Unit and security tests. architecture.md 18.
 *
 * `tests/integration` needs a live database and is skipped unless
 * TEST_DATABASE_URL is set, so `npm test` stays runnable without Neon.
 *
 * The setup file is a no-op unless TEST_WS_PROXY is set as well; it exists so
 * the integration tests can run against a local Postgres through a
 * WebSocket-to-TCP proxy, using the same driver production uses. See the file
 * itself for the two commands.
 *
 * Integration files run one at a time, because they share one database and
 * several of them assert on figures the whole database contributes to -- the
 * console overview counts every asset and request there is, and reads the
 * count twice to assert the difference. A file inserting rows in between makes
 * that difference wrong, which is a failure about scheduling rather than about
 * the code under test. Without a database they are skipped, so the fast suite
 * keeps its parallelism.
 */
const sharesADatabase = Boolean(process.env.TEST_DATABASE_URL);

export default defineConfig({
  /*
   * tsconfig keeps JSX for Next to compile (`preserve`); a test that renders
   * a page -- the scenario pages, tests/contract/scenarios.test.ts -- needs
   * it compiled here.
   */
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
