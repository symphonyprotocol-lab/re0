/** Backfill missing generation costs at current prices. Dry-run by default; --apply writes estimates. */
import nextEnv from '@next/env';
nextEnv.loadEnvConfig(process.cwd());
const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--apply' && !arg.startsWith('--model=') && !arg.startsWith('--before='))) throw new Error('Usage: tsx scripts/backfill-generation-costs.mts [--apply] [--model=MODEL] [--before=ISO]');
const { planGenerationCostBackfill, applyGenerationCostBackfill } = await import('../lib/services/backfill-generation-costs');
const before = args.find((arg) => arg.startsWith('--before='))?.slice('--before='.length);
const model = args.find((arg) => arg.startsWith('--model='))?.slice('--model='.length);
const plan = await planGenerationCostBackfill({ ...(before ? { before: new Date(before) } : {}), ...(model ? { model } : {}) });
const models = [...new Set([...plan.estimates, ...plan.skipped].map((row) => row.model))].map((name) => ({ model: name, estimated: plan.estimates.filter((row) => row.model === name).length, skipped: plan.skipped.filter((row) => row.model === name).map((row) => row.reason).reduce<Record<string, number>>((counts, reason) => ({ ...counts, [reason]: (counts[reason] ?? 0) + 1 }), {}) }));
console.log(JSON.stringify({ mode: args.includes('--apply') ? 'apply' : 'dry-run', at: plan.at, before: plan.before, candidates: plan.candidates, estimable: plan.estimates.length, models }, null, 2));
if (args.includes('--apply')) console.log(JSON.stringify(await applyGenerationCostBackfill(plan)));
process.exit(0);
