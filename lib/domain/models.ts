/**
 * The console's model page rules (rebuild-proposal.md 2.5, "模型"): any
 * number of entries per kind, exactly one enabled, and an enabled entry's
 * model and endpoint frozen -- changing what answers goes through enabling a
 * different entry, never through editing the live one.
 */
import { MODEL_ID_MAX_LENGTH, MODEL_KINDS, MODEL_NAME_MAX_LENGTH, MODEL_TIMEOUT_MS, type ModelKind } from '@/lib/constants';

export type ModelTransport = 'gateway' | 'openai_compatible';

export interface ModelConfigInput {
  name: string;
  kind: ModelKind;
  transport: ModelTransport;
  baseUrl: string | null;
  model: string;
  /** Empty means "keep the stored key" on edit, "none" on create. */
  apiKey: string;
  timeoutMs: number;
}

export type ModelConfigError = 'name' | 'kind' | 'transport' | 'base_url' | 'model' | 'api_key' | 'timeout';

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
  const model = str(raw.model);
  /* The gateway names models `provider/model`. */
  if (!model || model.length > MODEL_ID_MAX_LENGTH || (transport === 'gateway' && !/^[\w.-]+\/[\w.:-]+$/.test(model))) {
    return { error: 'model' };
  }
  const apiKey = str(raw.apiKey);
  if (apiKey.length > API_KEY_MAX_LENGTH) return { error: 'api_key' };
  const timeoutMs = Number(raw.timeoutMs ?? MODEL_TIMEOUT_MS.default);
  if (!Number.isInteger(timeoutMs) || timeoutMs < MODEL_TIMEOUT_MS.min || timeoutMs > MODEL_TIMEOUT_MS.max) {
    return { error: 'timeout' };
  }
  return { name, kind: raw.kind, transport, baseUrl, model, apiKey, timeoutMs };
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
