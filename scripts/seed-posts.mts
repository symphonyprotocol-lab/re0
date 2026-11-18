/**
 * RE0's example posts (lib/services/seed-posts.ts), for an administrator to
 * run by hand. Never run automatically; nothing in the app calls it.
 *
 * It reads no env file (.env.local may point at production): the database
 * is named on the command line, and any host that is not this machine is
 * refused -- the plan included -- unless --i-know-this-is-production is
 * given. The model settings come from that database; provider keys and
 * DATABASE_WS_PROXY, when needed, from the shell's own environment.
 * Prints the plan by default; --apply posts it and asks the Rees to answer,
 * at the platform's model cost.
 *
 *   npx tsx scripts/seed-posts.mts --database-url=postgres://… [--per-category=N] [--category=life] [--apply] [--i-know-this-is-production]
 */
const args = process.argv.slice(2);
const usage =
  'Usage: tsx scripts/seed-posts.mts --database-url=URL [--per-category=N (1-20, default 5)] [--category=CATEGORY] [--apply] [--i-know-this-is-production]';
const value = (name: string) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const known = ['--apply', '--i-know-this-is-production'];
if (args.some((arg) => !known.includes(arg) && !['--database-url=', '--per-category=', '--category='].some((prefix) => arg.startsWith(prefix)))) throw new Error(usage);

const databaseUrl = value('database-url');
if (!databaseUrl) throw new Error(`${usage}\nThe database must be given explicitly; no env file is read.`);
const { seedTargetCheck } = await import('../lib/services/seed-posts-guard');
const refusal = seedTargetCheck(databaseUrl, args.includes('--i-know-this-is-production'));
if (refusal) throw new Error(refusal);
process.env.DATABASE_URL = databaseUrl;

const perCategory = Number(value('per-category') ?? 5);
if (!Number.isInteger(perCategory) || perCategory < 1 || perCategory > 20) throw new Error(usage);
const category = value('category') ?? null;
const { REE_CATEGORIES } = await import('../lib/constants');
if (category && !(REE_CATEGORIES as readonly string[]).includes(category)) throw new Error(`${usage}\nCategories: ${REE_CATEGORIES.join(', ')}`);
const { planSeedPosts, applySeedPosts } = await import('../lib/services/seed-posts');
const plan = await planSeedPosts({ perCategory, category: category as never });
console.log(JSON.stringify({ mode: args.includes('--apply') ? 'apply' : 'dry-run', database: new URL(databaseUrl).host, posts: plan.length, plan: plan.map(({ category: c, reeName, question }) => ({ category: c, ree: reeName, question })) }, null, 2));
if (args.includes('--apply')) console.log(JSON.stringify(await applySeedPosts(plan)));
process.exit(0);
