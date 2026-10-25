'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import {
  llmConfigEntries,
  openLlmCredential,
  openModelCredential,
  probeLlmConfig,
  probeModelConfig,
  probeRenderConfig,
  recordAudit,
  updateLlmAssignment,
  updateLlmConfig,
  updateModelConfig,
  updateRenderConfig,
  updateRenderKeys,
  LlmConfigRefused,
  ModelConfigRefused,
  RenderConfigRefused,
  RENDER_PROBE_URL,
  type LlmProbeResult,
  type ModelProbeResult,
  type RenderProbeResult,
} from '@/lib/application/administration';
import {
  priceMicroFromUsd,
  REASONING_EFFORTS,
  TIMEOUT_MS,
  type ReasoningEffort,
} from '@/lib/domain/generation';
import { AdminChangeRefused } from '@/lib/domain/admin';
import {
  EMBEDDING_DIMENSIONS,
  isModelKind,
  mayCarryCredential,
  timeoutBoundsFor,
} from '@/lib/domain/model-config';
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
      error:
        | 'invalid_base_url'
        | 'invalid_model'
        | 'invalid_timeout'
        | 'api_key_required'
        | 'unknown_model';
    };

/**
 * The same probe for an entry as saved: one click on a row of the registry,
 * with the row's own endpoint, model, timeout and stored key. The form's
 * probe (`testLlmConfigAction`) answers "does what I typed work"; this one
 * answers "does what is in force still work", for every entry at once.
 */
export async function testLlmEntryAction(slug: string): Promise<LlmProbeActionResult> {
  const session = await requireAdminCapability('models');
  const entry = (await llmConfigEntries()).find((row) => row.slug === slug);
  if (!entry) return { kind: 'refused', error: 'unknown_model' };
  const apiKey = (await openLlmCredential(entry.id)) ?? '';
  if (apiKey.length === 0) return { kind: 'refused', error: 'api_key_required' };

  const bag = await headers();
  await recordAudit({
    administratorId: session.administratorId,
    action: 'llm_config.probe',
    targetType: 'llm_config',
    targetId: `${entry.baseUrl}#${entry.model}`,
    reason: `probe with ${entry.slug}`,
    clientAddress: clientAddress(bag),
    result: 'success',
  });

  const result = await probeLlmConfig({
    baseUrl: entry.baseUrl,
    model: entry.model,
    apiKey,
    timeoutMs: entry.timeoutMs,
    reasoningEffort: entry.supportsReasoning ? entry.reasoningEffort : null,
  });
  return { kind: 'result', ...result };
}

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

export type ModelProbeActionResult =
  | ({ kind: 'result' } & ModelProbeResult)
  | {
      kind: 'refused';
      error:
        | 'invalid_kind'
        | 'invalid_base_url'
        | 'invalid_model'
        | 'invalid_dimensions'
        | 'invalid_timeout'
        | 'api_key_required';
    };

/**
 * One call against a retrieval model endpoint as typed into the form -- saved
 * or not. Held to the rules the save applies, so a probe cannot be run
 * against a configuration the save would refuse; the credential is the typed
 * one, or the stored one opened for the same host, as in the generation
 * registry's probe.
 */
export async function testModelConfigAction(form: FormData): Promise<ModelProbeActionResult> {
  const session = await requireAdminCapability('models');

  const kind = String(form.get('kind') ?? '');
  if (!isModelKind(kind)) return { kind: 'refused', error: 'invalid_kind' };
  let baseUrl: URL;
  try {
    baseUrl = new URL(String(form.get('baseUrl') ?? ''));
  } catch {
    return { kind: 'refused', error: 'invalid_base_url' };
  }
  if (baseUrl.protocol !== 'https:') return { kind: 'refused', error: 'invalid_base_url' };
  const model = String(form.get('model') ?? '').trim();
  if (model.length === 0 || model.length > 120) return { kind: 'refused', error: 'invalid_model' };

  let dimensions: number | null = null;
  if (kind === 'embedding') {
    const value = Number(form.get('dimensions') ?? Number.NaN);
    if (
      !Number.isSafeInteger(value) ||
      value < EMBEDDING_DIMENSIONS.min ||
      value > EMBEDDING_DIMENSIONS.max
    ) {
      return { kind: 'refused', error: 'invalid_dimensions' };
    }
    dimensions = value;
  }
  const bounds = timeoutBoundsFor(kind);
  const timeoutMs = Number(form.get('timeoutMs') ?? Number.NaN);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < bounds.min || timeoutMs > bounds.max) {
    return { kind: 'refused', error: 'invalid_timeout' };
  }

  const target = baseUrl.toString().replace(/\/+$/, '');
  const typedKey = String(form.get('apiKey') ?? '').trim();
  const apiKey = typedKey.length > 0 ? typedKey : ((await openModelCredential(kind, target)) ?? '');
  if (apiKey.length === 0) return { kind: 'refused', error: 'api_key_required' };

  /* Audited for the same reason as the generation probe: an outbound call to
     an address the operator names, carrying a credential they also name. */
  const bag = await headers();
  await recordAudit({
    administratorId: session.administratorId,
    action: 'model_config.probe',
    targetType: 'model_config',
    targetId: `${kind}:${target}#${model}`,
    reason: typedKey.length > 0 ? 'probe with a typed credential' : `probe with the ${kind} key in force`,
    clientAddress: clientAddress(bag),
    result: 'success',
  });

  const result = await probeModelConfig({ kind, baseUrl: target, model, apiKey, dimensions, timeoutMs });
  return { kind: 'result', ...result };
}

export type RenderConfigError =
  | 'invalid_provider'
  | 'invalid_base_url'
  | 'invalid_api_key'
  | 'too_many_keys'
  | 'unknown_key'
  | 'reason_required'
  | 'unavailable';

export interface RenderConfigActionResult {
  ok: boolean;
  error?: RenderConfigError;
}

function renderRefusal(error: unknown, what: string): RenderConfigActionResult {
  if (error instanceof RenderConfigRefused) return { ok: false, error: error.code };
  if (error instanceof AdminChangeRefused && error.code === 'reason_required') {
    return { ok: false, error: 'reason_required' };
  }
  console.error(`${what} failed: ${error instanceof Error ? error.message : 'unknown'}`);
  return { ok: false, error: 'unavailable' };
}

/** The rendering fallback's provider: switching vendor, self-hosting and switching it off are one append. */
export async function updateRenderConfigAction(
  _previous: RenderConfigActionResult | null,
  form: FormData,
): Promise<RenderConfigActionResult> {
  const session = await requireAdminCapability('models');
  try {
    await updateRenderConfig({
      actor: actorOf(session, await headers()),
      provider: String(form.get('provider') ?? ''),
      baseUrl: String(form.get('baseUrl') ?? ''),
      /* An unchecked checkbox posts nothing: absence is "off". */
      enabled: form.get('enabled') !== null,
      reason: String(form.get('reason') ?? ''),
    });
    revalidatePath('/admin/models');
    return { ok: true };
  } catch (error) {
    return renderRefusal(error, 'render config');
  }
}

/**
 * The key pool of one provider, saved whole. The form posts the kept keys in
 * their new order as repeated `keep` ids, each with `label:<id>`, and
 * `enabled:<id>` / `clear:<id>` when checked; new keys come one per line.
 */
export async function updateRenderKeysAction(
  _previous: RenderConfigActionResult | null,
  form: FormData,
): Promise<RenderConfigActionResult> {
  const session = await requireAdminCapability('models');
  try {
    const keep = form.getAll('keep').map((value) => {
      const id = String(value);
      return {
        id,
        label: String(form.get(`label:${id}`) ?? ''),
        enabled: form.get(`enabled:${id}`) !== null,
        clearFailure: form.get(`clear:${id}`) !== null,
      };
    });
    const add = String(form.get('add') ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((apiKey) => ({ label: '', apiKey }));
    await updateRenderKeys({
      actor: actorOf(session, await headers()),
      provider: String(form.get('provider') ?? ''),
      keep,
      add,
      reason: String(form.get('reason') ?? ''),
    });
    revalidatePath('/admin/models');
    return { ok: true };
  } catch (error) {
    return renderRefusal(error, 'render keys');
  }
}

export type RenderProbeActionResult =
  | ({ kind: 'result' } & RenderProbeResult)
  | { kind: 'refused'; error: 'invalid_provider' | 'invalid_base_url' | 'no_key' };

/**
 * One render of a fixed public page through the configuration as typed. The
 * target is not the operator's to choose: this is a check of the service and
 * its keys, not a way to have the server fetch an address on request.
 */
export async function testRenderConfigAction(form: FormData): Promise<RenderProbeActionResult> {
  const session = await requireAdminCapability('models');
  const provider = String(form.get('provider') ?? '');
  const baseUrl = String(form.get('baseUrl') ?? '');

  /* Audited like the model probes: an outbound call the operator points. */
  const bag = await headers();
  await recordAudit({
    administratorId: session.administratorId,
    action: 'render_config.probe',
    targetType: 'render_config',
    targetId: `${provider}:${baseUrl.trim() || 'hosted'}`,
    reason: `render ${RENDER_PROBE_URL}`,
    clientAddress: clientAddress(bag),
    result: 'success',
  });

  const result = await probeRenderConfig({ provider, baseUrl });
  if ('refused' in result) return { kind: 'refused', error: result.refused };
  /* A probe can mark a key spent; the pool on the page should say so. */
  revalidatePath('/admin/models');
  return { kind: 'result', ...result };
}
