'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import {
  llmConfigEntries,
  openLlmCredential,
  probeLlmConfig,
  recordAudit,
  updateLlmAssignment,
  updateLlmConfig,
  updateModelConfig,
  LlmConfigRefused,
  ModelConfigRefused,
  type LlmProbeResult,
} from '@/lib/application/administration';
import {
  priceMicroFromUsd,
  REASONING_EFFORTS,
  TIMEOUT_MS,
  type ReasoningEffort,
} from '@/lib/domain/generation';
import { AdminChangeRefused } from '@/lib/domain/admin';
import { mayCarryCredential } from '@/lib/domain/model-config';
import { requireAdminCapability } from '@/lib/http/admin';
import { clientAddress } from '@/lib/http/client-address';

/**
 * The registry's one mutation -- adding an entry, editing one and switching
 * one off are the same append, distinguished only by which fields the form
 * posts -- and the assignment's one. Like every console action, both
 * re-resolve the session and re-check the capability: a server action is a
 * public endpoint with a generated name.
 */
export type LlmConfigError =
  | 'invalid_base_url'
  | 'invalid_model'
  | 'invalid_max_input'
  | 'invalid_max_output'
  | 'invalid_timeout'
  | 'invalid_price'
  | 'invalid_slug'
  | 'invalid_effort'
  | 'invalid_api_key'
  | 'api_key_required'
  | 'unknown_model'
  | 'reason_required'
  | 'unavailable';

export interface LlmConfigActionResult {
  ok: boolean;
  error?: LlmConfigError;
}

export async function updateLlmConfigAction(
  _previous: LlmConfigActionResult | null,
  form: FormData,
): Promise<LlmConfigActionResult> {
  const session = await requireAdminCapability('models');
  try {
    const bag = await headers();
    await updateLlmConfig({
      actor: {
        administratorId: session.administratorId,
        email: session.email,
        clientAddress: clientAddress(bag),
      },
      /* Absent for a new entry; present when appending to an existing one. */
      slug: form.get('slug') ? String(form.get('slug')) : null,
      label: String(form.get('label') ?? ''),
      baseUrl: String(form.get('baseUrl') ?? ''),
      model: String(form.get('model') ?? ''),
      /* Blank is "keep the stored credential"; the application refuses a
         blank one on an entry that has none. */
      apiKey: form.get('apiKey') ? String(form.get('apiKey')) : null,
      maxInputTokens: Number(form.get('maxInputTokens') ?? Number.NaN),
      maxOutputTokens: Number(form.get('maxOutputTokens') ?? Number.NaN),
      timeoutMs: Number(form.get('timeoutMs') ?? Number.NaN),
      /* Typed in dollars per million tokens, stored in micro-USD. The field
         names carry the unit so the two can never be posted into each other;
         a blank or non-numeric one becomes NaN and is refused below. */
      promptPriceMicro: priceMicroFromUsd(Number(form.get('promptPriceUsd') ?? Number.NaN)),
      completionPriceMicro: priceMicroFromUsd(Number(form.get('completionPriceUsd') ?? Number.NaN)),
      cachePriceMicro: priceMicroFromUsd(Number(form.get('cachePriceUsd') ?? Number.NaN)),
      /* An unchecked checkbox posts nothing: absence is "off". */
      enabled: form.get('enabled') !== null,
      supportsTools: form.get('supportsTools') !== null,
      supportsReasoning: form.get('supportsReasoning') !== null,
      supportsVision: form.get('supportsVision') !== null,
      /* The select is disabled for a non-reasoning model, so it posts nothing
         -- and the application refuses the pair anyway. */
      reasoningEffort: form.get('reasoningEffort') ? String(form.get('reasoningEffort')) : null,
      reason: String(form.get('reason') ?? ''),
    });
    revalidatePath('/admin/models');
    return { ok: true };
  } catch (error) {
    if (error instanceof LlmConfigRefused) return { ok: false, error: error.code };
    if (error instanceof AdminChangeRefused && error.code === 'reason_required') {
      return { ok: false, error: 'reason_required' };
    }
    console.error(`llm config failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return { ok: false, error: 'unavailable' };
  }
}

function actorOf(session: { administratorId: string; email: string }, bag: Headers) {
  return {
    administratorId: session.administratorId,
    email: session.email,
    clientAddress: clientAddress(bag),
  };
}

export async function updateLlmAssignmentAction(
  _previous: LlmConfigActionResult | null,
  form: FormData,
): Promise<LlmConfigActionResult> {
  const session = await requireAdminCapability('models');
  try {
    await updateLlmAssignment({
      actor: actorOf(session, await headers()),
      /* An empty option is the documented null: newest enabled for trial,
         the trial model for subscribers. */
      trialSlug: form.get('trialSlug') ? String(form.get('trialSlug')) : null,
      subscriberSlug: form.get('subscriberSlug') ? String(form.get('subscriberSlug')) : null,
      reason: String(form.get('reason') ?? ''),
    });
    revalidatePath('/admin/models');
    return { ok: true };
  } catch (error) {
    if (error instanceof LlmConfigRefused) return { ok: false, error: error.code };
    if (error instanceof AdminChangeRefused && error.code === 'reason_required') {
      return { ok: false, error: 'reason_required' };
    }
    console.error(`llm assignment failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return { ok: false, error: 'unavailable' };
  }
}

export type LlmProbeActionResult =
  | ({ kind: 'result' } & LlmProbeResult)
  | {
      kind: 'refused';
      error: 'invalid_base_url' | 'invalid_model' | 'invalid_timeout' | 'api_key_required';
    };

/**
 * One call against the endpoint as typed into the form -- saved or not.
 * The same fields the save validates, held to the same rules, so a probe
 * cannot be run against a configuration the save would refuse.
 */
export async function testLlmConfigAction(form: FormData): Promise<LlmProbeActionResult> {
  const session = await requireAdminCapability('models');

  let baseUrl: URL;
  try {
    baseUrl = new URL(String(form.get('baseUrl') ?? ''));
  } catch {
    return { kind: 'refused', error: 'invalid_base_url' };
  }
  if (baseUrl.protocol !== 'https:') return { kind: 'refused', error: 'invalid_base_url' };
  const model = String(form.get('model') ?? '').trim();
  if (model.length === 0 || model.length > 120) return { kind: 'refused', error: 'invalid_model' };
  /*
   * The credential: the one typed into the form when there is one -- so a new
   * entry can be checked before it is saved -- and otherwise the selected
   * entry's stored key, opened here. The browser never holds a saved key, so
   * without the second path a probe could only ever test a brand new entry.
   *
   * The stored key is opened only for the host it was saved for: a probe is
   * one call to whatever base URL the form holds, and without that check it
   * would hand an operator any entry's key at an endpoint of their choosing.
   */
  const slug = String(form.get('slug') ?? '').trim();
  const typedKey = String(form.get('apiKey') ?? '').trim();
  let apiKey = typedKey;
  if (apiKey.length === 0 && slug.length > 0) {
    const entry = (await llmConfigEntries()).find((row) => row.slug === slug);
    apiKey =
      (entry && mayCarryCredential(entry.baseUrl, baseUrl.toString())
        ? await openLlmCredential(entry.id)
        : null) ?? '';
  }
  if (apiKey.length === 0) return { kind: 'refused', error: 'api_key_required' };

  const timeoutMs = Number(form.get('timeoutMs') ?? Number.NaN);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < TIMEOUT_MS.min || timeoutMs > TIMEOUT_MS.max) {
    return { kind: 'refused', error: 'invalid_timeout' };
  }
  const effort = String(form.get('reasoningEffort') ?? '');
  const reasoningEffort =
    form.get('supportsReasoning') !== null && REASONING_EFFORTS.includes(effort as ReasoningEffort)
      ? (effort as ReasoningEffort)
      : null;

  const target = baseUrl.toString().replace(/\/+$/, '');

  /*
   * Audited even though it changes nothing. The probe makes the server open an
   * outbound call to an address an operator names, carrying a credential they
   * also name -- the one console verb whose whole effect is off-platform, and
   * so the one that most needs a record of who pointed it where.
   */
  const bag = await headers();
  await recordAudit({
    administratorId: session.administratorId,
    action: 'llm_config.probe',
    targetType: 'llm_config',
    targetId: `${target}#${model}`,
    reason: typedKey.length > 0 ? 'probe with a typed credential' : `probe with ${slug}`,
    clientAddress: clientAddress(bag),
    result: 'success',
  });

  const result = await probeLlmConfig({
    baseUrl: target,
    model,
    apiKey,
    timeoutMs,
    reasoningEffort,
  });
  return { kind: 'result', ...result };
}

export type ModelConfigError =
  | 'invalid_kind'
  | 'invalid_base_url'
  | 'invalid_model'
  | 'invalid_dimensions'
  | 'invalid_timeout'
  | 'invalid_api_key'
  | 'api_key_required'
  | 'reason_required'
  | 'unavailable';

export interface ModelConfigActionResult {
  ok: boolean;
  error?: ModelConfigError;
}

/**
 * The retrieval models' one mutation. Saving an entry for a kind that has none,
 * editing the one it has and switching it off are the same append; which of
 * the three it is is only a matter of which fields the form posts.
 */
export async function updateModelConfigAction(
  _previous: ModelConfigActionResult | null,
  form: FormData,
): Promise<ModelConfigActionResult> {
  const session = await requireAdminCapability('models');
  try {
    await updateModelConfig({
      actor: actorOf(session, await headers()),
      kind: String(form.get('kind') ?? ''),
      label: String(form.get('label') ?? ''),
      baseUrl: String(form.get('baseUrl') ?? ''),
      model: String(form.get('model') ?? ''),
      /* Blank keeps the stored credential; the application refuses a blank
         one where there is nothing to keep. */
      apiKey: form.get('apiKey') ? String(form.get('apiKey')) : null,
      /* Absent for a reranker, whose form has no width field at all. */
      dimensions: form.get('dimensions') === null ? null : Number(form.get('dimensions')),
      timeoutMs: Number(form.get('timeoutMs') ?? Number.NaN),
      /* An unchecked checkbox posts nothing: absence is "off". */
      enabled: form.get('enabled') !== null,
      reason: String(form.get('reason') ?? ''),
    });
    /* Both models are read on the request path, so the pages that report
       their state have to be re-rendered, not only this one. */
    revalidatePath('/admin/models');
    revalidatePath('/admin/retrieval');
    return { ok: true };
  } catch (error) {
    if (error instanceof ModelConfigRefused) return { ok: false, error: error.code };
    if (error instanceof AdminChangeRefused && error.code === 'reason_required') {
      return { ok: false, error: 'reason_required' };
    }
    console.error(`model config failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return { ok: false, error: 'unavailable' };
  }
}
