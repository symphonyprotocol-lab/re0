/** Four real calls (Free/Plan before and after a temporary custom-rate change).
 * Explicit --live required. Restores the original rate in finally; preserves call logs. */
import nextEnv from '@next/env';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateText } from 'ai';
import { and, asc, eq, gte, inArray, sql } from 'drizzle-orm';
import { modelFor } from '../lib/infra/ai/models';
import { gatewayGenerationPricing } from '../lib/infra/ai/gateway-generation-pricing';
import { db, schema } from '../lib/infra/db';
import { audit } from '../lib/services/admin';
import { configuredProviderRate, providerPrices } from '../lib/services/provider-pricing';
import { perMillionUsd } from '../lib/domain/models';
import { picoUsd, usdPico, type ProviderRate } from '../lib/domain/provider-cost';

const args = process.argv.slice(2);
if (!args.includes('--live') || args.some((arg) => arg !== '--live' && !arg.startsWith('--baseline='))) throw new Error('Usage: npx tsx scripts/verify-generation-billing.mts --live [--baseline=FREE_ID,PLAN_ID]');
const baselineIds = args.find((arg) => arg.startsWith('--baseline='))?.slice('--baseline='.length).split(',');
nextEnv.loadEnvConfig(process.cwd());
const database = db();
const runId = `billing-verification-${new Date().toISOString()}`;
const reportPath = join(tmpdir(), `re0-${Date.now()}-billing-verification.json`);
const check = (condition: unknown, message: string): void => { if (!condition) throw new Error(message); };
function endpointOf(raw: string): string {
  const url = new URL(raw); url.username = ''; url.password = ''; url.search = ''; url.hash = '';
  return url.href.replace(/\/+$/, '');
}
function decimal(value: string | number): [bigint, number] {
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(value));
  if (!match) throw new Error('Invalid decimal cost');
  const exponent = Number(match[3] ?? 0);
  let units = BigInt(match[1]! + (match[2] ?? ''));
  let scale = (match[2]?.length ?? 0) - exponent;
  if (scale < 0) { units *= 10n ** BigInt(-scale); scale = 0; }
  return [units, scale];
}
function sameUsd(a: string, b: string | number): boolean {
  const [x, xs] = decimal(a); const [y, ys] = decimal(b);
  return x * 10n ** BigInt(ys) === y * 10n ** BigInt(xs);
}
const snapshotFields = { id: schema.modelCall.id, costUsd: schema.modelCall.costUsd, costBasis: schema.modelCall.costBasis, rate: schema.modelCall.rate, priceRevision: schema.modelCall.priceRevision };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const report: { runId: string; calls: Record<string, unknown>[]; checks: Record<string, unknown> } = { runId, calls: [], checks: {} };
let original: ProviderRate | undefined;
let temporary: ProviderRate | undefined;
let changed = false;
let target: { endpoint: string; model: string } | undefined;

async function replaceRate(nextRate: ProviderRate, expected: ProviderRate) {
  await database.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('pricing:providers'))`);
    const before = await providerPrices(tx);
    const current = configuredProviderRate(before, { service: 'generation', ...target! });
    check(isDeepStrictEqual(current, expected), 'Rate changed outside this verification; refusing to overwrite it');
    const rates = before.rates.filter((r) => !(r.service === 'generation' && r.endpoint === nextRate.endpoint && r.model === nextRate.model && r.account === nextRate.account));
    rates.push(nextRate);
    const next = { revision: randomUUID(), rates };
    await tx.insert(schema.providerPricing).values({ id: 1, ...next, updatedBy: null }).onConflictDoUpdate({ target: schema.providerPricing.id, set: { ...next, updatedBy: null, updatedAt: new Date() } });
    await audit(tx, { administratorId: null, action: 'pricing.update', target: 'providers', before, after: { ...next, verification: runId } });
  });
}
async function run(audience: 'free' | 'plan', phase: string, expectedRate?: ProviderRate) {
  const started = new Date();
  const generation = await modelFor('generation', audience, { purpose: 'probe' });
  const result = await generateText({
    model: generation.model, prompt: 'Reply with the single word OK. No explanation.',
    maxOutputTokens: 128, maxRetries: 0,
    abortSignal: AbortSignal.timeout(Math.min(generation.endpoint.timeoutMs, 45_000)),
  });
  const requestId = result.response.id;
  let rows = await database.select().from(schema.modelCall).where(and(
    eq(schema.modelCall.kind, 'generation'), eq(schema.modelCall.audience, audience),
    eq(schema.modelCall.purpose, 'probe'), gte(schema.modelCall.createdAt, started),
    generation.endpoint.configId ? eq(schema.modelCall.configId, generation.endpoint.configId) : undefined,
  ));
  rows = rows.filter((r) => !report.calls.some((old) => old.id === r.id));
  const exact = requestId ? rows.filter((r) => r.requestId === requestId) : [];
  rows = exact.length ? exact : rows.filter((r) => r.inputTokens === result.usage.inputTokens && r.outputTokens === result.usage.outputTokens);
  check(rows.length === 1, `Expected one durable call record for ${audience}/${phase}, got ${rows.length}`);
  const row = rows[0]!;
  check(row.status === 'succeeded' && row.usageKnown && row.costUsd !== null, `Incomplete usage/cost for ${audience}/${phase}`);
  check(row.inputTokens === result.usage.inputTokens && row.outputTokens === result.usage.outputTokens, 'Stored tokens differ from provider usage');
  if (expectedRate) {
    const expected = picoUsd(BigInt(row.inputTokens) * usdPico(expectedRate.usdPerUnit) + BigInt(row.outputTokens) * usdPico(expectedRate.outputUsdPerUnit!));
    check(row.costBasis === 'configured_rate' && sameUsd(row.costUsd!, expected), 'Manual cost arithmetic mismatch');
    check(isDeepStrictEqual(row.rate, expectedRate), 'Stored manual rate snapshot mismatch');
  } else {
    const gateway = result.providerMetadata?.gateway as { cost?: string | number } | undefined;
    if (gateway?.cost !== undefined) check(row.costBasis === 'provider_reported' && sameUsd(row.costUsd!, gateway.cost), 'Stored cost differs from Gateway bill');
    else {
      check(row.costBasis === 'estimated' && row.rate?.source === 'https://ai-gateway.vercel.sh/v1/models', 'Gateway did not use its own prices');
      const expected = picoUsd(BigInt(row.inputTokens) * usdPico(row.rate!.usdPerUnit) + BigInt(row.outputTokens) * usdPico(row.rate!.outputUsdPerUnit!));
      check(sameUsd(row.costUsd!, expected), 'Gateway catalog arithmetic mismatch');
    }
  }
  const summary = { phase, audience, id: row.id, model: row.model, inputTokens: row.inputTokens, outputTokens: row.outputTokens, costUsd: row.costUsd, costBasis: row.costBasis,
    inputUsdPerMillion: row.rate ? perMillionUsd(row.rate.usdPerUnit) : null,
    outputUsdPerMillion: row.rate?.outputUsdPerUnit !== undefined ? perMillionUsd(row.rate.outputUsdPerUnit) : null,
    requestId: row.requestId, priceRevision: row.priceRevision, verified: true };
  report.calls.push(summary); console.log(JSON.stringify(summary));
}

async function main() {
  const free = await modelFor('generation', 'free', { purpose: 'probe' });
  const plan = await modelFor('generation', 'plan', { purpose: 'probe' });
  check(free.endpoint.transport === 'openai_compatible', 'This verification expects a custom Free model');
  check(plan.endpoint.transport === 'gateway', 'This verification expects a Gateway Plan model');
  target = { endpoint: endpointOf(free.endpoint.baseUrl!), model: free.endpoint.model };
  original = configuredProviderRate(await providerPrices(), { service: 'generation', ...target });
  check(original?.outputUsdPerUnit !== undefined, 'Both current custom token prices are required');
  temporary = { ...original!, usdPerUnit: picoUsd(usdPico(original!.usdPerUnit) * 2n), outputUsdPerUnit: picoUsd(usdPico(original!.outputUsdPerUnit!) * 2n), source: runId };
  if (baselineIds) {
    check(baselineIds.length === 2, 'Two baseline call IDs are required');
    for (const [index, audience] of (['free', 'plan'] as const).entries()) {
      const [row] = await database.select().from(schema.modelCall).where(eq(schema.modelCall.id, baselineIds[index]!));
      const endpoint = audience === 'free' ? free.endpoint : plan.endpoint;
      check(row && row.audience === audience && row.configId === endpoint.configId && row.model === endpoint.model && row.purpose === 'probe' && row.status === 'succeeded' && row.usageKnown && row.costUsd !== null, 'Baseline call does not match the live verification');
      const rate = audience === 'free' ? original! : (await gatewayGenerationPricing(endpoint.model))?.rate;
      check(rate?.outputUsdPerUnit !== undefined && row!.rate !== null, 'Baseline rate unavailable');
      check(sameUsd(row!.rate!.usdPerUnit, rate!.usdPerUnit) && sameUsd(row!.rate!.outputUsdPerUnit!, rate!.outputUsdPerUnit!), 'Baseline rate differs from current model price');
      const expected = picoUsd(BigInt(row!.inputTokens) * usdPico(rate!.usdPerUnit) + BigInt(row!.outputTokens) * usdPico(rate!.outputUsdPerUnit!));
      check(sameUsd(row!.costUsd!, expected), 'Baseline cost arithmetic mismatch');
      const summary = { phase: 'before', audience, id: row!.id, model: row!.model, inputTokens: row!.inputTokens, outputTokens: row!.outputTokens,
        costUsd: row!.costUsd, costBasis: row!.costBasis, inputUsdPerMillion: perMillionUsd(rate!.usdPerUnit), outputUsdPerMillion: perMillionUsd(rate!.outputUsdPerUnit!),
        requestId: row!.requestId, priceRevision: row!.priceRevision, verified: true, reusedLiveBaseline: true };
      report.calls.push(summary); console.log(JSON.stringify(summary));
    }
  } else {
    await run('free', 'before', original);
    await run('plan', 'before');
  }
  const history = await database.select(snapshotFields).from(schema.modelCall).where(eq(schema.modelCall.kind, 'generation')).orderBy(asc(schema.modelCall.id));
  const beforeHash = digest(history);
  await replaceRate(temporary, original!); changed = true;
  console.log(JSON.stringify({ phase: 'temporary-rate-change', inputUsdPerMillion: perMillionUsd(temporary.usdPerUnit), outputUsdPerMillion: perMillionUsd(temporary.outputUsdPerUnit!) }));
  await run('free', 'after', temporary);
  await run('plan', 'after');
  const previous = await database.select(snapshotFields).from(schema.modelCall).where(inArray(schema.modelCall.id, history.map((r) => r.id))).orderBy(asc(schema.modelCall.id));
  check(digest(previous) === beforeHash, 'Historical call costs or price snapshots changed');
  report.checks.historicalRowsUnchanged = history.length;
  report.checks.historicalSnapshotHash = beforeHash;
  report.checks.newCustomRateUsed = true;
  report.checks.gatewayBillingVerifiedBeforeAndAfter = true;
}
try { await main(); }
finally {
  if (changed) {
    await replaceRate(original!, temporary!);
    const restored = configuredProviderRate(await providerPrices(), { service: 'generation', ...target! });
    check(isDeepStrictEqual(restored, original), 'Failed to restore original rates');
    report.checks.originalRateRestored = true;
  }
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ reportPath, checks: report.checks }));
}
process.exit(0);
