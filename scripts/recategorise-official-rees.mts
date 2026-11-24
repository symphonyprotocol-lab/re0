/**
 * One-off: moves the official account's Wikivoyage guides from `life` to
 * `travel` and its fiction, poetry and drama classics from `other` to
 * `literature` (lib/services/official-categories.ts). Run by hand.
 *
 * It reads no env file (.env.local points at production): the database is
 * named on the command line, and any host that is not this machine is
 * refused -- the dry run included -- unless --i-know-this-is-production is
 * given. Prints counts by default; --list prints every Ree it would move and
 * every one left in `other`; --apply moves them.
 *
 *   npx tsx scripts/recategorise-official-rees.mts --database-url=postgres://… [--owner="RE0 Official"]… [--include=slug,…] [--exclude=slug,…] [--list] [--apply] [--i-know-this-is-production]
 */
const args = process.argv.slice(2);
const usage =
  'Usage: tsx scripts/recategorise-official-rees.mts --database-url=URL [--owner=NAME]… [--include=SLUG,…] [--exclude=SLUG,…] [--list] [--apply] [--i-know-this-is-production]';
const flags = ['--apply', '--list', '--i-know-this-is-production'];
const prefixes = ['--database-url=', '--owner=', '--include=', '--exclude='];
if (args.some((arg) => !flags.includes(arg) && !prefixes.some((prefix) => arg.startsWith(prefix)))) throw new Error(usage);
const values = (name: string) => args.filter((arg) => arg.startsWith(`--${name}=`)).map((arg) => arg.slice(name.length + 3));
const slugs = (name: string) => values(name).flatMap((value) => value.split(',')).map((slug) => slug.trim()).filter(Boolean);

const databaseUrl = values('database-url')[0];
if (!databaseUrl) throw new Error(`${usage}\nThe database must be given explicitly; no env file is read.`);
const { seedTargetCheck } = await import('../lib/services/seed-posts-guard');
const refusal = seedTargetCheck(databaseUrl, args.includes('--i-know-this-is-production'));
if (refusal) throw new Error(`Refusing ${databaseUrl.startsWith('postgres') ? new URL(databaseUrl).hostname : 'that URL'}: it is not a database on this machine. Pass --i-know-this-is-production to change it on purpose.`);
process.env.DATABASE_URL = databaseUrl;

const { planRecategorise, applyRecategorise, DEFAULT_OFFICIAL_OWNERS } = await import('../lib/services/official-categories');
const owners = values('owner');
const plan = await planRecategorise({ owners: owners.length ? owners : DEFAULT_OFFICIAL_OWNERS, include: slugs('include'), exclude: slugs('exclude') });
const apply = args.includes('--apply');
const brief = (list: typeof plan.travel) => list.map(({ slug, name, owner }) => `${slug}  ${name}  (${owner})`);
console.log(
  JSON.stringify(
    {
      mode: apply ? 'apply' : 'dry-run',
      database: new URL(databaseUrl).host,
      owners: plan.owners,
      'life → travel': plan.travel.length,
      'other → literature': plan.literature.length,
      'left in other': plan.remainingOther.length,
      ...(args.includes('--list') ? { travel: brief(plan.travel), literature: brief(plan.literature), remainingOther: brief(plan.remainingOther) } : {}),
    },
    null,
    2,
  ),
);
if (!plan.owners.length) console.warn('No user has that name; nothing to move.');
if (apply) console.log(JSON.stringify({ moved: await applyRecategorise(plan) }));
process.exit(0);
