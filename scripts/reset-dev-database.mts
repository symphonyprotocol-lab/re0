/**
 * Drops and recreates the public schema of the database DATABASE_URL points
 * at, then applies db/migrations. rebuild-proposal.md 8: the Neon dev branch
 * starts over with the rebuild.
 *
 *   npm run db:reset-dev -- --confirm=<endpoint id>
 *
 * Local mode refuses unless every check below passes, and prints what it is
 * about to drop first:
 *
 *   - the host is a Neon endpoint (`ep-…….neon.tech`);
 *   - it is not the endpoint any of POSTGRES_* / PGHOST* name -- in
 *     .env.local those point at the production main branch;
 *   - it is not listed in PRODUCTION_DATABASE_ENDPOINTS (comma-separated
 *     endpoint ids; set it where the production id is known);
 *   - DATABASE_URL_UNPOOLED, which drizzle-kit migrates through, names the
 *     same endpoint;
 *   - `--confirm` repeats the endpoint id, so nobody resets a branch they did
 *     not look at.
 *
 *   npm run db:prepare-preview        (vercel.json, preview builds only)
 *
 * Preview mode runs in the Vercel build. Neon's integration gives each git
 * branch a copy of main, which still holds the old 86-table schema the new
 * baseline cannot apply on top of. When -- and only when -- VERCEL_ENV is
 * `preview`, the endpoint is not a listed production one, and the schema is the old
 * one (it has the legacy `workspace` table and no `ree` table), the copy is
 * cleared once; later builds of the same branch find `ree` and leave it alone.
 */
import nextEnv from '@next/env';
import { neon } from '@neondatabase/serverless';
import { spawnSync } from 'node:child_process';

nextEnv.loadEnvConfig(process.cwd());

/** Endpoints that serve production. Never reset, whatever else is true. */
const PRODUCTION_ENDPOINTS = new Set(
  (process.env.PRODUCTION_DATABASE_ENDPOINTS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);

const PRODUCTION_VARIABLES = [
  'POSTGRES_URL',
  'POSTGRES_URL_NON_POOLING',
  'POSTGRES_URL_NO_SSL',
  'POSTGRES_PRISMA_URL',
  'POSTGRES_HOST',
  'PGHOST',
  'PGHOST_UNPOOLED',
];

function refuse(reason: string): never {
  console.error(`refused: ${reason}`);
  process.exit(1);
}

/** The `ep-…` endpoint id from a URL or a bare host, pooler or not. */
function endpointOf(value: string | undefined): string | null {
  if (!value) return null;
  let host = value;
  try {
    host = new URL(value).hostname;
  } catch {
    /* a bare host */
  }
  const first = host.split('.')[0] ?? '';
  const endpoint = first.replace(/-pooler$/, '');
  return endpoint.startsWith('ep-') ? endpoint : null;
}

const url = process.env.DATABASE_URL;
if (!url) refuse('DATABASE_URL is not set');
const host = new URL(url).hostname;
const endpoint = endpointOf(url);
const preview = process.argv.includes('--preview');

console.log(`DATABASE_URL host: ${host}`);
console.log(`endpoint:          ${endpoint ?? '(not a Neon endpoint)'}`);

if (!endpoint || !host.endsWith('.neon.tech')) refuse('DATABASE_URL is not a Neon endpoint');
if (PRODUCTION_ENDPOINTS.has(endpoint)) refuse(`${endpoint} is a production endpoint`);

const sql = neon(url);

if (preview) {
  if (process.env.VERCEL_ENV !== 'preview') refuse('--preview runs only in a Vercel preview build');
  const [state] = (await sql`
    select to_regclass('public.workspace') is not null as legacy,
           to_regclass('public.ree') is not null as rebuilt
  `) as { legacy: boolean; rebuilt: boolean }[];
  if (!state?.legacy || state.rebuilt) {
    console.log('preview database already on the rebuild schema (or empty); nothing to clear');
    process.exit(0);
  }
  console.log('preview database holds the legacy schema; clearing it once');
} else {
  for (const name of PRODUCTION_VARIABLES) {
    const other = endpointOf(process.env[name]);
    if (other && other === endpoint) refuse(`DATABASE_URL names the same endpoint as ${name} (production)`);
  }
  const unpooled = endpointOf(process.env.DATABASE_URL_UNPOOLED);
  if (unpooled && unpooled !== endpoint) {
    refuse(`DATABASE_URL_UNPOOLED names ${unpooled}, not ${endpoint}; migrations would go elsewhere`);
  }
  const confirm = process.argv.find((arg) => arg.startsWith('--confirm='))?.slice('--confirm='.length);
  if (confirm !== endpoint) refuse(`pass --confirm=${endpoint} to reset this endpoint`);
}

console.log(`dropping schema public (and drizzle's migration journal) on ${endpoint} ...`);
await sql`drop schema if exists drizzle cascade`;
await sql`drop schema public cascade`;
await sql`create schema public`;
await sql`grant all on schema public to public`;
console.log('schema recreated; applying migrations');

if (!preview) {
  /* The build runs `db:migrate` itself right after this. */
  const run = spawnSync('npx', ['drizzle-kit', 'migrate'], { stdio: 'inherit' });
  if (run.status !== 0) refuse('drizzle-kit migrate failed');
  /* drizzle-kit has been seen to exit 0 without applying anything; trust the schema, not the exit code. */
  const [applied] = (await sql`select to_regclass('public.ree') is not null as ok`) as { ok: boolean }[];
  if (!applied?.ok) refuse('schema cleared but migrations did not apply; run `npm run db:migrate`');
}
console.log('done');
