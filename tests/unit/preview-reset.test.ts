import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('preview database reset', () => {
  it('is not part of any build any more', () => {
    const vercel = JSON.parse(readFileSync(join(process.cwd(), 'vercel.json'), 'utf8')) as { buildCommand: string };
    expect(vercel.buildCommand).not.toMatch(/prepare-preview|db:migrate|reset-dev/);
    expect(vercel.buildCommand).toContain('npm run build');
  });

  it('refuses in a Preview build unless explicitly opted in, before touching the database', () => {
    const run = (extra: Record<string, string>) => spawnSync(process.execPath, [join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'scripts/reset-dev-database.mts', '--preview'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        NODE_ENV: 'test',
        VERCEL_ENV: 'preview',
        /* Unreachable on purpose: a refusal must come before any query. */
        DATABASE_URL: 'postgres://user:pw@ep-preview-test-000000.us-east-2.aws.neon.tech/neondb',
        PRODUCTION_DATABASE_ENDPOINTS: 'ep-production-000000',
        ...extra,
      },
    });
    const refused = run({});
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/Preview deployments are retired.*ALLOW_PREVIEW_DATABASE_RESET=1/);
  });
});

describe('cron schedule', () => {
  it('runs the orphan upload reaper daily', () => {
    const vercel = JSON.parse(readFileSync(join(process.cwd(), 'vercel.json'), 'utf8')) as { crons: { path: string; schedule: string }[] };
    expect(vercel.crons).toContainEqual({ path: '/api/cron/purge-uploads', schedule: '50 3 * * *' });
  });
});
