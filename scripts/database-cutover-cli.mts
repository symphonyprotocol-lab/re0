/**
 * The production database step and the cutover's manual levers
 * (scripts/database-cutover.mts, docs/cutover/production-cutover.md).
 *
 *   npm run db:deploy                                   production build, after `next build` (vercel.json)
 *   npm run db:cutover -- status                        what the database holds; changes nothing
 *   npm run db:cutover -- rollback --confirm=<target>   old app's schema back into public, rebuild parked
 *   npm run db:cutover -- resume --confirm=<target>     the reverse, after a rollback
 *   npm run db:cutover -- drop-legacy --confirm=<target> end of the rollback window
 *
 * Against production, from a checkout linked to the Vercel project, without
 * writing any secret to disk:
 *
 *   vercel env run -e production -- npm run db:cutover -- rollback --confirm=<target>
 *
 * `<target>` is the Neon endpoint id (`ep-…`) the command prints when it is
 * missing or wrong, so nobody changes a database they did not look at. The
 * connection is DATABASE_URL_UNPOOLED, else DATABASE_URL -- the same one
 * drizzle-kit migrates through.
 */
import nextEnv from '@next/env';
import { Client, neonConfig } from '@neondatabase/serverless';
import { join } from 'node:path';
import { CutoverRefused, deployDatabase, dropLegacy, inspect, planDeploy, resumeCutover, rollbackCutover, type DatabaseState } from './database-cutover.mjs';

nextEnv.loadEnvConfig(process.cwd());

function refuse(reason: string): never {
  console.error(`refused: ${reason}`);
  process.exit(1);
}

const command = process.argv[2] ?? '';
const confirm = process.argv.find((arg) => arg.startsWith('--confirm='))?.slice('--confirm='.length);
const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) refuse('DATABASE_URL_UNPOOLED / DATABASE_URL is not set');

const parsed = new URL(url);
const local = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
/* The Neon endpoint id (`ep-…`, pooler or not); a local database is named by host and database. */
const first = parsed.hostname.split('.')[0]!.replace(/-pooler$/, '');
const target = first.startsWith('ep-') ? first : `${parsed.hostname}${parsed.pathname}`;

/* The local Docker database sits behind tests/fixtures/wsproxy.mjs; never route a remote host through it. */
const wsProxy = local && !process.env.VERCEL ? process.env.DATABASE_WS_PROXY : undefined;
if (wsProxy) {
  neonConfig.wsProxy = () => wsProxy;
  neonConfig.useSecureWebSocket = false;
  neonConfig.pipelineTLS = false;
  neonConfig.pipelineConnect = false;
}

function describe(state: DatabaseState): string {
  return [
    `public=${state.public}`,
    `journal_last=${state.journalLast ?? 'none'}`,
    `legacy_main=${state.legacyArchived}`,
    `rebuild_parked=${state.rebuildParked}`,
    `vector_in=${state.vectorSchema ?? 'none'}`,
  ].join(' ');
}

if (command === 'deploy' && process.env.VERCEL && process.env.VERCEL_ENV !== 'production') {
  refuse('db:deploy runs only in a production build (Preview builds do not touch a database)');
}
console.log(`database: ${target}`);

const client = new Client({ connectionString: url });
try {
  await client.connect();
} catch (error) {
  /* The driver rejects with a bare WebSocket ErrorEvent; say what failed instead of dumping it. */
  refuse(`could not connect to ${target}: ${(error as { message?: string })?.message || 'connection error'}`);
}
try {
  switch (command) {
    case 'deploy': {
      const started = Date.now();
      const result = await deployDatabase(client, join(process.cwd(), 'db', 'migrations'));
      console.log(`before:  ${describe(result.before)}`);
      console.log(`plan:    ${result.reason}`);
      if (result.archived) console.log('archived the old app: its tables and types moved from public to legacy_main, drizzle renamed to legacy_drizzle');
      console.log(result.applied.length ? `applied: ${result.applied.map((m) => m.tag).join(', ')}` : 'applied: nothing pending');
      console.log(`after:   ${describe(await inspect(client))} (${Date.now() - started} ms, one transaction)`);
      break;
    }
    case 'status': {
      const state = await inspect(client);
      console.log(describe(state));
      const plan = planDeploy(state);
      console.log('refuse' in plan ? `a production build would refuse: ${plan.refuse}` : `a production build would: ${plan.reason}`);
      break;
    }
    case 'rollback':
    case 'resume':
    case 'drop-legacy': {
      if (confirm !== target) refuse(`pass --confirm=${target} to ${command} this database`);
      const action = command === 'rollback' ? rollbackCutover : command === 'resume' ? resumeCutover : dropLegacy;
      const after = await action(client);
      console.log(`${command} done: ${describe(after)}`);
      if (command === 'rollback') console.log('next: Instant Rollback to the old production deployment (Vercel dashboard, or `vercel rollback <deployment>`)');
      if (command === 'resume') console.log('next: promote the rebuild deployment again (Vercel dashboard, or `vercel promote <deployment>`)');
      break;
    }
    default:
      refuse('usage: database-cutover-cli.mts deploy | status | rollback | resume | drop-legacy [--confirm=<target>]');
  }
} catch (error) {
  if (error instanceof CutoverRefused) refuse(error.message);
  console.error(error);
  process.exit(1);
} finally {
  await client.end();
}
