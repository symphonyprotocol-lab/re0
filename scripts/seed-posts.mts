/**
 * RE0's example posts (lib/services/seed-posts.ts). Prints the plan by
 * default; `--apply` posts it and asks the Rees to answer, on whatever
 * database the environment points at, at the platform's model cost. Never
 * run automatically.
 *
 *   npx tsx scripts/seed-posts.mts [--per-category=N] [--category=life] [--apply]
 */
import nextEnv from '@next/env';
nextEnv.loadEnvConfig(process.cwd());
const args = process.argv.slice(2);
const usage = 'Usage: tsx scripts/seed-posts.mts [--per-category=N (1-20, default 5)] [--category=CATEGORY] [--apply]';
if (args.some((arg) => arg !== '--apply' && !arg.startsWith('--per-category=') && !arg.startsWith('--category='))) throw new Error(usage);
const perCategory = Number(args.find((arg) => arg.startsWith('--per-category='))?.slice('--per-category='.length) ?? 5);
if (!Number.isInteger(perCategory) || perCategory < 1 || perCategory > 20) throw new Error(usage);
const category = args.find((arg) => arg.startsWith('--category='))?.slice('--category='.length) ?? null;
const { REE_CATEGORIES } = await import('../lib/constants');
if (category && !(REE_CATEGORIES as readonly string[]).includes(category)) throw new Error(`${usage}\nCategories: ${REE_CATEGORIES.join(', ')}`);
const { planSeedPosts, applySeedPosts } = await import('../lib/services/seed-posts');
const plan = await planSeedPosts({ perCategory, category: category as never });
console.log(JSON.stringify({ mode: args.includes('--apply') ? 'apply' : 'dry-run', posts: plan.length, plan: plan.map(({ category: c, reeName, question }) => ({ category: c, ree: reeName, question })) }, null, 2));
if (args.includes('--apply')) console.log(JSON.stringify(await applySeedPosts(plan)));
process.exit(0);
