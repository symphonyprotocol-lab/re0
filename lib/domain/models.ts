/**
 * The console's model page rules (rebuild-proposal.md 2.5, "模型"): any
 * number of entries per kind, one enabled per audience for generation and
 * one per kind otherwise, and an enabled entry's
 * model and endpoint frozen -- changing what answers goes through enabling a
 * different entry, never through editing the live one.
 */
import { MODEL_ID_MAX_LENGTH, MODEL_KINDS, MODEL_NAME_MAX_LENGTH, MODEL_TIMEOUT_MS, OPENAI_SPEECH_BASE, type ModelKind } from '@/lib/constants';
import { picoUsd, usdPico } from '@/lib/domain/provider-cost';
import { parseServicePricing, type ServicePricingInput } from '@/lib/domain/service-pricing';
import { demoSpeechRate } from '@/lib/domain/product-demo';

export type ModelTransport = 'gateway' | 'openai_compatible';
export type GenerationAudience = 'free' | 'plan';
export interface ModelGenerationPrice { inputUsdPerMillion: string; outputUsdPerMillion: string }
/** Human-facing prices use USD / 1M tokens; stored supplier rates use USD / token. */
export function perTokenUsd(perMillion: string): string { return picoUsd(usdPico(perMillion) / 1_000_000n); }
export function perMillionUsd(perToken: string): string { return picoUsd(usdPico(perToken) * 1_000_000n).replace(/\.?0+$/, ''); }

export interface ModelConfigInput {
  name: string;
  kind: ModelKind;
  transport: ModelTransport;
  baseUrl: string | null;
  model: string;
  /** Empty means "keep the stored key" on edit, "none" on create. */
  apiKey: string;
  timeoutMs: number;
  /** Omitted preserves a saved price; null explicitly removes it. */
  generationPricing?: ModelGenerationPrice | null;
  costPricing?: ServicePricingInput | null;
}

export type ModelConfigError = 'name' | 'kind' | 'transport' | 'base_url' | 'model' | 'api_key' | 'timeout' | 'generation_pricing' | 'cost_pricing';

export const API_KEY_MAX_LENGTH = 512;

export function isModelKind(value: unknown): value is ModelKind {
  return typeof value === 'string' && (MODEL_KINDS as readonly string[]).includes(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function parseModelConfig(raw: Record<string, unknown>): ModelConfigInput | { error: ModelConfigError } {
  const name = str(raw.name);
  if (!name || name.length > MODEL_NAME_MAX_LENGTH) return { error: 'name' };
  if (!isModelKind(raw.kind)) return { error: 'kind' };
  const transport = raw.transport === 'gateway' || raw.transport === 'openai_compatible' ? raw.transport : null;
  if (!transport) return { error: 'transport' };
  let baseUrl: string | null = null;
  if (transport === 'openai_compatible') {
    try {
      const url = new URL(str(raw.baseUrl));
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return { error: 'base_url' };
      baseUrl = url.toString().replace(/\/+$/, '');
    } catch {
      return { error: 'base_url' };
    }
  }
  if (raw.kind === 'speech' && transport === 'openai_compatible' && baseUrl !== OPENAI_SPEECH_BASE) return { error: 'base_url' };
  const model = str(raw.model);
  /* The gateway names models `provider/model`. */
  if (!model || model.length > MODEL_ID_MAX_LENGTH || (transport === 'gateway' && !/^[\w.-]+\/[\w.:-]+$/.test(model))) {
    return { error: 'model' };
  }
  if (raw.kind === 'speech' && transport === 'gateway' && demoSpeechRate(model) === undefined) return { error: 'model' };
  const apiKey = str(raw.apiKey);
  if (apiKey.length > API_KEY_MAX_LENGTH) return { error: 'api_key' };
  const timeoutMs = Number(raw.timeoutMs ?? MODEL_TIMEOUT_MS.default);
  if (!Number.isInteger(timeoutMs) || timeoutMs < MODEL_TIMEOUT_MS.min || timeoutMs > MODEL_TIMEOUT_MS.max) {
    return { error: 'timeout' };
  }
  let generationPricing: ModelGenerationPrice | null | undefined;
  if (raw.kind === 'generation' && transport === 'openai_compatible' && raw.generationPricing !== undefined) {
    const value = raw.generationPricing;
    if (value === null) generationPricing = null;
    else if (typeof value === 'object' && !Array.isArray(value)) {
      const prices = value as Record<string, unknown>;
      if (typeof prices.inputUsdPerMillion !== 'string' || typeof prices.outputUsdPerMillion !== 'string') return { error: 'generation_pricing' };
      const input = str(prices.inputUsdPerMillion);
      const output = str(prices.outputUsdPerMillion);
      if (!input && !output) generationPricing = null;
      else if (/^\d{1,8}(?:\.\d{1,6})?$/.test(input) && /^\d{1,8}(?:\.\d{1,6})?$/.test(output)) generationPricing = { inputUsdPerMillion: input, outputUsdPerMillion: output };
      else return { error: 'generation_pricing' };
    } else return { error: 'generation_pricing' };
  }
  let costPricing: ServicePricingInput | null | undefined;
  if (raw.costPricing !== undefined && (raw.kind === 'embedding' || raw.kind === 'transcription')) {
    try { costPricing = parseServicePricing(raw.costPricing, raw.kind); }
    catch { return { error: 'cost_pricing' }; }
  }
  return { name, kind: raw.kind, transport, baseUrl, model, apiKey, timeoutMs, ...(generationPricing !== undefined ? { generationPricing } : {}), ...(costPricing !== undefined ? { costPricing } : {}) };
}

/** What the page shows instead of a key. */
export function keyTail(apiKey: string): string {
  return apiKey.slice(-4);
}

/** An enabled entry may be renamed or given a new key or timeout; its model and endpoint stay. */
export function changesWhatAnswers(
  current: { transport: ModelTransport; baseUrl: string | null; model: string },
  next: { transport: ModelTransport; baseUrl: string | null; model: string },
): boolean {
  return current.transport !== next.transport || current.baseUrl !== next.baseUrl || current.model !== next.model;
}

/**
 * Whether a stored key may travel with an entry to `next`: only when the
 * endpoint keeps its origin. Otherwise an operator could point an entry at a
 * host of their own, leave the key blank, and receive somebody else's key.
 */
export function mayCarryKey(stored: { transport: ModelTransport; baseUrl: string | null }, next: { transport: ModelTransport; baseUrl: string | null }): boolean {
  if (stored.transport !== next.transport) return false;
  if (stored.transport === 'gateway') return true;
  try {
    return new URL(stored.baseUrl ?? '').origin === new URL(next.baseUrl ?? '').origin;
  } catch {
    return false;
  }
}

/** Switching generation or transcription takes effect at once; embedding needs a re-embed job (step 5). */
export function switchesImmediately(kind: ModelKind): boolean {
  return kind !== 'embedding';
}
