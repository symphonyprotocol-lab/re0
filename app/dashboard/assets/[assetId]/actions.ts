'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { after } from 'next/server';
import { AppError } from '@/contracts/errors';
import { runOperation } from '@/lib/application/ingestion';
import {
  applyOwnerLifecycleAction,
  declareAssetRights,
  editAssetMetadata,
  requestAssetRebuild,
  updateParseScope,
} from '@/lib/application/assets';
import type { LifecycleStatus } from '@/lib/domain';
import { moveAsset } from '@/lib/application/channels';
import { ChannelRefused } from '@/lib/domain/channel';
import {
  isOwnerLifecycleAction,
  PlatformAssetRefused,
  type OwnerLifecycleAction,
} from '@/lib/domain/asset';
import {
  createSiteKey,
  SiteKeyLimit,
  deleteFaqEntry,
  FaqInvalid,
  revokeSiteKey,
  saveFaqEntry,
  SiteKeyInvalid,
  updateSiteKey,
  type SiteKeyRefusal,
} from '@/lib/application/embed';
import type { FaqRefusal } from '@/lib/domain/faq';
import { requireSession } from '@/lib/http/session';
import {
  applyShowcaseVerb,
  checkShowcaseDomain,
  deleteShowcase,
  enableShowcase,
  removeShowcaseDomain,
  ShowcaseDomainInvalid,
  startShowcaseDomain,
  generateShowcaseDraft,
  removeShowcaseAsset,
  ShowcaseInvalid,
  updateShowcase,
  updateShowcaseLead,
  uploadShowcaseAsset,
  type ShowcaseDraftOutcome,
  type ShowcaseRefusal,
} from '@/lib/application/showcase';
import { newRequestId } from '@/lib/http/respond';
import { translations } from '@/lib/i18n/server';

/** Queue a rebuild and start it. Also handed to the list's per-row refresh control. */
export interface RebuildAssetActionResult {
  ok: boolean;
  /** False when a pending build was already waiting. */
  created?: boolean;
  error?: 'not_found' | 'access_denied' | 'invalid' | 'quota' | 'unavailable';
}

export async function rebuildAssetAction(
  _previous: RebuildAssetActionResult | null,
  form: FormData,
): Promise<RebuildAssetActionResult> {
  const assetId = String(form.get('assetId') ?? '');
  const session = await requireSession(`/dashboard/assets/${assetId}`);
  try {
    const { operationId, created } = await requestAssetRebuild({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      assetId,
    });
    revalidatePath(`/dashboard/assets/${assetId}`);
    revalidatePath('/dashboard/assets');
    /* Run whether this call queued it or found it waiting: a pending row
       nobody has claimed yet is exactly what the owner is asking about, and
       `runOperation` claims conditionally, so a drain that gets there first
       simply wins. */
    {
      after(async () => {
        try {
          await runOperation({ operationId });
        } catch (error) {
          console.error(`asset rebuild run failed: ${error instanceof Error ? error.message : 'unknown'}`);
        }
      });
    }
    return { ok: true, created };
  } catch (error) {
    if (error instanceof AppError) {
      if (error.code === 'asset_not_found') return { ok: false, error: 'not_found' };
      if (error.code === 'access_denied') return { ok: false, error: 'access_denied' };
      if (error.code === 'invalid_request') return { ok: false, error: 'invalid' };
      if (error.code === 'quota_exceeded') return { ok: false, error: 'quota' };
    }
    console.error(`rebuild asset failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return { ok: false, error: 'unavailable' };
  }
}

/* ------------------------------------------------------ owner management */

/**
 * The owner's verbs beside rebuild (requirement.md 5.2): pause and resume,
 * each answering with where the asset now is. The use case
 * re-checks the role and the domain rule; the page only decides what is
 * drawn.
 */
export interface OwnerLifecycleActionResult {
  ok: boolean;
  action?: OwnerLifecycleAction;
  lifecycleStatus?: LifecycleStatus;
  /** Pause only: queued fetches withdrawn with it. */
  cancelledOperations?: number;
  error?: 'not_found' | 'access_denied' | 'invalid' | 'unavailable';
}

export async function ownerLifecycleAction(
  _previous: OwnerLifecycleActionResult | null,
  form: FormData,
): Promise<OwnerLifecycleActionResult> {
  const assetId = String(form.get('assetId') ?? '');
  const action = String(form.get('action') ?? '');
  const session = await requireSession(`/dashboard/assets/${assetId}`);
  if (!isOwnerLifecycleAction(action)) return { ok: false, error: 'invalid' };
  try {
    const result = await applyOwnerLifecycleAction({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      assetId,
      action,
    });
    revalidatePath(`/dashboard/assets/${assetId}`);
    revalidatePath('/dashboard/assets');
    return {
      ok: true,
      action,
      lifecycleStatus: result.lifecycleStatus,
      cancelledOperations: result.cancelledOperations,
    };
  } catch (error) {
    if (error instanceof AppError) {
      if (error.code === 'asset_not_found') return { ok: false, error: 'not_found' };
      if (error.code === 'access_denied') return { ok: false, error: 'access_denied' };
      if (error.code === 'invalid_request') return { ok: false, error: 'invalid' };
    }
    console.error(`${action} asset failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return { ok: false, error: 'unavailable' };
  }
}

/** Edit title, description, language and visibility. */
export interface EditAssetMetadataActionResult {
  ok: boolean;
  lifecycleStatus?: LifecycleStatus;
  /** True when the visibility change queued the asset for review. */
  error?:
    | 'not_found'
    | 'access_denied'
    | 'invalid_title'
    | 'invalid_metadata'
    | 'rights_required'
    | 'rights_generated'
    | 'archived'
    | 'unavailable';
}

/** The rights declaration as a form posts it (components/dashboard/rights-fields.tsx `RIGHTS_FIELDS`). */
function rightsOf(form: FormData) {
  return {
    origin: form.get('rightsOrigin') ?? undefined,
    license: form.get('rightsLicense') ?? undefined,
    generation: form.get('rightsGeneration') ?? undefined,
    note: form.get('rightsNote') ?? undefined,
  };
}

/* ------------------------------------------------------------- materials */

/**
 * The owner's rights declaration (review-visibility-proposal.md 5.1). One
 * result shape; the panel shows the line for the refusal.
 */
export interface MaterialsActionResult {
  ok: boolean;
  error?:
    | 'not_found'
    | 'access_denied'
    | 'invalid'
    | 'rights_invalid'
    | 'rights_generated'
    | 'unavailable';
}

function materialsRefusal(error: unknown, verb: string): MaterialsActionResult {
  if (error instanceof PlatformAssetRefused) {
    if (error.code === 'rights_invalid' || error.code === 'rights_required') return { ok: false, error: 'rights_invalid' };
    if (error.code === 'rights_generated') return { ok: false, error: 'rights_generated' };
  }
  if (error instanceof AppError) {
    if (error.code === 'asset_not_found') return { ok: false, error: 'not_found' };
    if (error.code === 'access_denied') return { ok: false, error: 'access_denied' };
    if (error.code === 'invalid_request') return { ok: false, error: 'invalid' };
  }
  console.error(`${verb} failed: ${error instanceof Error ? error.message : 'unknown'}`);
  return { ok: false, error: 'unavailable' };
}

export async function declareRightsAction(
  _previous: MaterialsActionResult | null,
  form: FormData,
): Promise<MaterialsActionResult> {
  const assetId = String(form.get('assetId') ?? '');
  const session = await requireSession(`/dashboard/assets/${assetId}`);
  try {
    await declareAssetRights({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      assetId,
      userId: session.user.id,
      rights: rightsOf(form),
    });
    revalidatePath(`/dashboard/assets/${assetId}`);
    revalidatePath('/dashboard/assets');
    return { ok: true };
  } catch (error) {
    return materialsRefusal(error, 'declare rights');
  }
}

export async function editAssetMetadataAction(
  _previous: EditAssetMetadataActionResult | null,
  form: FormData,
): Promise<EditAssetMetadataActionResult> {
  const assetId = String(form.get('assetId') ?? '');
  const session = await requireSession(`/dashboard/assets/${assetId}`);
  try {
    const result = await editAssetMetadata({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      assetId,
      userId: session.user.id,
      title: String(form.get('title') ?? ''),
      description: String(form.get('description') ?? ''),
      language: String(form.get('language') ?? ''),
      rights: rightsOf(form),
    });
    revalidatePath(`/dashboard/assets/${assetId}`);
    revalidatePath('/dashboard/assets');
    return { ok: true, lifecycleStatus: result.lifecycleStatus };
  } catch (error) {
    if (error instanceof PlatformAssetRefused) {
      if (error.code === 'invalid_title') return { ok: false, error: 'invalid_title' };
      if (error.code === 'archived') return { ok: false, error: 'archived' };
      if (error.code === 'rights_required' || error.code === 'rights_invalid') return { ok: false, error: 'rights_required' };
      if (error.code === 'rights_generated') return { ok: false, error: 'rights_generated' };
      return { ok: false, error: 'invalid_metadata' };
    }
    if (error instanceof AppError) {
      if (error.code === 'asset_not_found') return { ok: false, error: 'not_found' };
      if (error.code === 'access_denied') return { ok: false, error: 'access_denied' };
      if (error.code === 'invalid_request') return { ok: false, error: 'invalid_metadata' };
    }
    console.error(`edit asset failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return { ok: false, error: 'unavailable' };
  }
}

/** Configure the parse scope (and the refresh cadence where the source has one). */
export interface UpdateParseScopeActionResult {
  ok: boolean;
  /** True when a rebuild is what applies the saved scope. */
  rebuildAdvised?: boolean;
  /** With `error: 'invalid_scope'`: the entry that was refused, when one was. */
  detail?: string;
  error?:
    | 'not_found'
    | 'access_denied'
    | 'unsupported'
    | 'invalid_scope'
    | 'invalid_refresh_policy'
    | 'unavailable';
}

export async function updateParseScopeAction(
  _previous: UpdateParseScopeActionResult | null,
  form: FormData,
): Promise<UpdateParseScopeActionResult> {
  const assetId = String(form.get('assetId') ?? '');
  const session = await requireSession(`/dashboard/assets/${assetId}`);
  try {
    const result = await updateParseScope({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      assetId,
      folders: String(form.get('folders') ?? ''),
      excludeFolders: String(form.get('excludeFolders') ?? ''),
      excludeFiles: String(form.get('excludeFiles') ?? ''),
      indexDepth: String(form.get('indexDepth') ?? ''),
      refreshPolicy: String(form.get('refreshPolicy') ?? ''),
    });
    revalidatePath(`/dashboard/assets/${assetId}`);
    return { ok: true, rebuildAdvised: result.rebuildAdvised };
  } catch (error) {
    if (error instanceof PlatformAssetRefused) {
      if (error.code === 'unsupported_source') return { ok: false, error: 'unsupported' };
      if (error.code === 'invalid_refresh_policy') return { ok: false, error: 'invalid_refresh_policy' };
      return { ok: false, error: 'invalid_scope', detail: error.message };
    }
    if (error instanceof AppError) {
      if (error.code === 'asset_not_found') return { ok: false, error: 'not_found' };
      if (error.code === 'access_denied') return { ok: false, error: 'access_denied' };
      if (error.code === 'invalid_request') return { ok: false, error: 'invalid_scope' };
    }
    console.error(`configure asset failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return { ok: false, error: 'unavailable' };
  }
}

/* ------------------------------------------------------------ site keys */

/**
 * The website widget's keys (requirement.md 9.4). Three verbs, one result
 * shape: the form shows the key that was created or saved, or names the
 * field that was refused. The use cases re-check the role and that the
 * asset is this workspace's.
 */
export interface SiteKeyActionResult {
  ok: boolean;
  error?: SiteKeyRefusal | 'limit' | 'plan_limit' | 'denied' | 'not_found' | 'unavailable';
}

function siteKeyRefusal(error: unknown, verb: string): SiteKeyActionResult {
  if (error instanceof SiteKeyInvalid) return { ok: false, error: error.field };
  if (error instanceof SiteKeyLimit) return { ok: false, error: error.ceiling === 'plan' ? 'plan_limit' : 'limit' };
  if (error instanceof AppError) {
    if (error.code === 'api_key_limit_exceeded') return { ok: false, error: 'limit' };
    if (error.code === 'access_denied') return { ok: false, error: 'denied' };
    if (error.code === 'asset_not_found') return { ok: false, error: 'not_found' };
  }
  console.error(`${verb} site key failed: ${error instanceof Error ? error.message : 'unknown'}`);
  return { ok: false, error: 'unavailable' };
}

function siteKeySettings(form: FormData) {
  return {
    name: String(form.get('name') ?? ''),
    origins: String(form.get('origins') ?? ''),
    dailyLimit: String(form.get('dailyLimit') ?? ''),
    welcome: String(form.get('welcome') ?? ''),
    accent: String(form.get('accent') ?? ''),
  };
}

export async function createSiteKeyAction(
  _previous: SiteKeyActionResult | null,
  form: FormData,
): Promise<SiteKeyActionResult> {
  const assetId = String(form.get('assetId') ?? '');
  const session = await requireSession(`/dashboard/assets/${assetId}`);
  try {
    await createSiteKey({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      assetId,
      ...siteKeySettings(form),
    });
    revalidatePath(`/dashboard/assets/${assetId}`);
    return { ok: true };
  } catch (error) {
    return siteKeyRefusal(error, 'create');
  }
}

export async function updateSiteKeyAction(
  _previous: SiteKeyActionResult | null,
  form: FormData,
): Promise<SiteKeyActionResult> {
  const assetId = String(form.get('assetId') ?? '');
  const siteKeyId = String(form.get('siteKeyId') ?? '');
  const session = await requireSession(`/dashboard/assets/${assetId}`);
  try {
    await updateSiteKey({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      siteKeyId,
      ...siteKeySettings(form),
    });
    revalidatePath(`/dashboard/assets/${assetId}`);
    return { ok: true };
  } catch (error) {
    return siteKeyRefusal(error, 'update');
  }
}

export async function revokeSiteKeyAction(
  _previous: SiteKeyActionResult | null,
  form: FormData,
): Promise<SiteKeyActionResult> {
  const assetId = String(form.get('assetId') ?? '');
  const siteKeyId = String(form.get('siteKeyId') ?? '');
  const session = await requireSession(`/dashboard/assets/${assetId}`);
  try {
    await revokeSiteKey({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      siteKeyId,
    });
    revalidatePath(`/dashboard/assets/${assetId}`);
    return { ok: true };
  } catch (error) {
    return siteKeyRefusal(error, 'revoke');
  }
}

/* ------------------------------------------------------------------ faq */

/**
 * The owner's FAQ (lib/domain/faq.ts): save an entry, remove one. Either
 * queues a rebuild and starts it, as the rebuild button does, so the entry
 * reaches retrieval without a second click.
 */
export interface FaqActionResult {
  ok: boolean;
  error?: FaqRefusal | 'denied' | 'not_found' | 'quota' | 'unavailable';
}

function faqRefusal(error: unknown, verb: string): FaqActionResult {
  if (error instanceof FaqInvalid) return { ok: false, error: error.field };
  if (error instanceof AppError) {
    if (error.code === 'access_denied') return { ok: false, error: 'denied' };
    if (error.code === 'asset_not_found') return { ok: false, error: 'not_found' };
    if (error.code === 'quota_exceeded') return { ok: false, error: 'quota' };
  }
  console.error(`${verb} faq entry failed: ${error instanceof Error ? error.message : 'unknown'}`);
  return { ok: false, error: 'unavailable' };
}

export async function saveFaqEntryAction(
  _previous: FaqActionResult | null,
  form: FormData,
): Promise<FaqActionResult> {
  const assetId = String(form.get('assetId') ?? '');
  const session = await requireSession(`/dashboard/assets/${assetId}`);
  try {
    const entryId = String(form.get('entryId') ?? '');
    const result = await saveFaqEntry({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      assetId,
      entryId: entryId.length > 0 ? entryId : null,
      question: String(form.get('question') ?? ''),
      answer: String(form.get('answer') ?? ''),
      pageUrl: String(form.get('pageUrl') ?? ''),
    });
    after(() => runOperation({ operationId: result.operationId }));
    revalidatePath(`/dashboard/assets/${assetId}`);
    return { ok: true };
  } catch (error) {
    return faqRefusal(error, 'save');
  }
}

export async function deleteFaqEntryAction(
  _previous: FaqActionResult | null,
  form: FormData,
): Promise<FaqActionResult> {
  const assetId = String(form.get('assetId') ?? '');
  const session = await requireSession(`/dashboard/assets/${assetId}`);
  try {
    const result = await deleteFaqEntry({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      assetId,
      entryId: String(form.get('entryId') ?? ''),
    });
    after(() => runOperation({ operationId: result.operationId }));
    revalidatePath(`/dashboard/assets/${assetId}`);
    return { ok: true };
  } catch (error) {
    return faqRefusal(error, 'delete');
  }
}

/* --------------------------------------------------------------- showcase */

/**
 * The asset's showcase page (lib/domain/showcase.ts): enable one, edit
 * what it says, draft it from the asset, publish, disable, restore, and
 * the logo and screenshot. One result shape: the form shows what changed
 * or names the field that was refused. The use cases re-check the role and
 * that the asset is this workspace's.
 */
export interface ShowcaseActionResult {
  ok: boolean;
  error?:
    | ShowcaseRefusal
    | 'denied'
    | 'not_found'
    | 'quota'
    | 'rate_limited'
    | 'not_ready'
    | 'unavailable'
    | 'domain_host'
    | 'domain_plan'
    | 'domain_not_configured'
    | 'domain_taken'
    | 'domain_status'
    | 'domain_limit'
    | 'domain_provider';
  /** Set by the draft action: how the drafting ended. */
  draft?: ShowcaseDraftOutcome;
}

function showcaseRefusal(error: unknown, verb: string): ShowcaseActionResult {
  if (error instanceof ShowcaseInvalid) return { ok: false, error: error.field };
  if (error instanceof ShowcaseDomainInvalid) return { ok: false, error: `domain_${error.field}` };
  if (error instanceof AppError) {
    if (error.code === 'claim_verification_failed') return { ok: false, error: 'domain_limit' };
    if (error.code === 'provider_unavailable') return { ok: false, error: 'domain_provider' };
    if (error.code === 'access_denied') return { ok: false, error: 'denied' };
    if (error.code === 'asset_not_found') return { ok: false, error: 'not_found' };
    if (error.code === 'asset_not_ready') return { ok: false, error: 'not_ready' };
    if (error.code === 'quota_exceeded') return { ok: false, error: 'quota' };
    if (error.code === 'rate_limited') return { ok: false, error: 'rate_limited' };
  }
  console.error(`${verb} showcase failed: ${error instanceof Error ? error.message : 'unknown'}`);
  return { ok: false, error: 'unavailable' };
}

function revalidateShowcase(assetId: string, slug?: string): void {
  revalidatePath(`/dashboard/assets/${assetId}`);
  if (slug) revalidatePath(`/s/${slug}`);
}

/** Enable the page and draft it from the asset in one go; a draft that cannot run leaves the page enabled and empty. */
export async function enableShowcaseAction(
  _previous: ShowcaseActionResult | null,
  form: FormData,
): Promise<ShowcaseActionResult> {
  const assetId = String(form.get('assetId') ?? '');
  const session = await requireSession(`/dashboard/assets/${assetId}`);
  try {
    const { locale } = await translations();
    const { showcase, created } = await enableShowcase({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      assetId,
      kind: String(form.get('kind') ?? ''),
      locale,
    });
    let draft: ShowcaseDraftOutcome | undefined;
    /* Only a page made by this call is drafted: a repeat (two tabs, a replay) must not spend Calls again. */
    if (created) {
      try {
        draft = (
          await generateShowcaseDraft({
            workspaceId: session.workspace.id,
            role: session.workspace.role,
            assetId,
            requestId: newRequestId(),
          })
        ).outcome;
      } catch (error) {
        console.warn(`showcase first draft skipped: ${error instanceof Error ? error.message : 'unknown'}`);
      }
    }
    revalidateShowcase(assetId, showcase.slug);
    return { ok: true, draft };
  } catch (error) {
    return showcaseRefusal(error, 'enable');
  }
}

/**
 * A `datetime-local` value is wall-clock time with no zone; the form sends
 * the browser's offset beside it, so the instant stored is the one the
 * owner saw. Empty stays empty (no expiry); anything unreadable is passed
 * on for the use case to refuse.
 */
function localToIso(local: string, tzOffset: FormDataEntryValue | null): string {
  if (local.trim().length === 0) return '';
  const wall = Date.parse(`${local.trim()}Z`);
  const offset = Number(tzOffset ?? 0);
  if (!Number.isFinite(wall) || !Number.isFinite(offset)) return 'invalid';
  return new Date(wall + offset * 60_000).toISOString();
}

function pairs(form: FormData, label: string, value: string): { label: string; url: string }[] {
  const labels = form.getAll(label).map(String);
  const urls = form.getAll(value).map(String);
  return labels.map((text, at) => ({ label: text, url: urls[at] ?? '' }));
}

export async function updateShowcaseAction(
  _previous: ShowcaseActionResult | null,
  form: FormData,
): Promise<ShowcaseActionResult> {
  const assetId = String(form.get('assetId') ?? '');
  const session = await requireSession(`/dashboard/assets/${assetId}`);
  try {
    const titles = form.getAll('featureTitle').map(String);
    const bodies = form.getAll('featureBody').map(String);
    const showcase = await updateShowcase({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      assetId,
      kind: String(form.get('kind') ?? ''),
      content: {
        name: form.get('name'),
        tagline: form.get('tagline'),
        summary: form.get('summary'),
        facts: form.get('facts'),
        features: titles.map((title, at) => ({ title, body: bodies[at] ?? '' })),
        audience: form.get('audience'),
        pricing: form.get('pricing'),
        links: pairs(form, 'linkLabel', 'linkUrl'),
        ctas: pairs(form, 'ctaLabel', 'ctaUrl'),
      },
      starterQuestions: String(form.get('starterQuestions') ?? ''),
      slug: String(form.get('slug') ?? ''),
      access: String(form.get('access') ?? ''),
      locale: String(form.get('locale') ?? ''),
      accent: String(form.get('accent') ?? ''),
      dailyLimit: String(form.get('dailyLimit') ?? ''),
      ...(form.has('brandingEditable') ? { showBranding: form.get('showBranding') === 'true' } : {}),
      password: String(form.get('password') ?? ''),
      clearPassword: form.get('clearPassword') === 'true',
      ...(form.has('expiresAt') ? { expiresAt: localToIso(String(form.get('expiresAt') ?? ''), form.get('tzOffset')) } : {}),
    });
    revalidateShowcase(assetId, showcase.slug);
    return { ok: true };
  } catch (error) {
    return showcaseRefusal(error, 'update');
  }
}

/** Draft the page from the asset again: the generated fields, or every shown field when `overwrite` is set. */
export async function draftShowcaseAction(
  _previous: ShowcaseActionResult | null,
  form: FormData,
): Promise<ShowcaseActionResult> {
  const assetId = String(form.get('assetId') ?? '');
  const session = await requireSession(`/dashboard/assets/${assetId}`);
  try {
    const result = await generateShowcaseDraft({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      assetId,
      overwrite: form.get('overwrite') === 'true',
      requestId: newRequestId(),
    });
    revalidateShowcase(assetId, result.showcase.slug);
    return { ok: true, draft: result.outcome };
  } catch (error) {
    return showcaseRefusal(error, 'draft');
  }
}

export async function showcaseVerbAction(
  _previous: ShowcaseActionResult | null,
  form: FormData,
): Promise<ShowcaseActionResult> {
  const assetId = String(form.get('assetId') ?? '');
  const session = await requireSession(`/dashboard/assets/${assetId}`);
  try {
    const showcase = await applyShowcaseVerb({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      assetId,
      verb: String(form.get('verb') ?? ''),
    });
    revalidateShowcase(assetId, showcase.slug);
    return { ok: true };
  } catch (error) {
    return showcaseRefusal(error, 'verb');
  }
}

/** Delete the page; the panel then offers to make a new one. The old link stops resolving at once. */
export async function deleteShowcaseAction(
  _previous: ShowcaseActionResult | null,
  form: FormData,
): Promise<ShowcaseActionResult> {
  const assetId = String(form.get('assetId') ?? '');
  const slug = String(form.get('slug') ?? '');
  const session = await requireSession(`/dashboard/assets/${assetId}`);
  try {
    await deleteShowcase({ workspaceId: session.workspace.id, role: session.workspace.role, assetId });
    revalidateShowcase(assetId, slug || undefined);
    revalidatePath('/dashboard/showcases');
    return { ok: true };
  } catch (error) {
    return showcaseRefusal(error, 'delete');
  }
}

export async function uploadShowcaseAssetAction(
  _previous: ShowcaseActionResult | null,
  form: FormData,
): Promise<ShowcaseActionResult> {
  const assetId = String(form.get('assetId') ?? '');
  const session = await requireSession(`/dashboard/assets/${assetId}`);
  try {
    const kind = form.get('kind') === 'screenshot' ? 'screenshot' : 'logo';
    const file = form.get('file');
    if (form.get('remove') === 'true') {
      const showcase = await removeShowcaseAsset({ workspaceId: session.workspace.id, role: session.workspace.role, assetId, kind });
      revalidateShowcase(assetId, showcase.slug);
      return { ok: true };
    }
    if (!(file instanceof File) || file.size === 0) return { ok: false, error: 'asset_size' };
    const showcase = await uploadShowcaseAsset({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      assetId,
      kind,
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
    revalidateShowcase(assetId, showcase.slug);
    return { ok: true };
  } catch (error) {
    return showcaseRefusal(error, 'asset');
  }
}

/** Handle a lead: mark it handled or new, or delete it (lib/application/showcase/leads.ts). */
export async function showcaseLeadAction(
  _previous: ShowcaseActionResult | null,
  form: FormData,
): Promise<ShowcaseActionResult> {
  const assetId = String(form.get('assetId') ?? '');
  const session = await requireSession(`/dashboard/assets/${assetId}`);
  try {
    await updateShowcaseLead({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      assetId,
      leadId: String(form.get('leadId') ?? ''),
      verb: String(form.get('verb') ?? ''),
    });
    revalidatePath(`/dashboard/assets/${assetId}`);
    revalidatePath('/dashboard', 'layout');
    return { ok: true };
  } catch (error) {
    return showcaseRefusal(error, 'lead');
  }
}

/** The page's own host (lib/application/showcase/domain.ts): claim one, check where it stands, or remove it. */
export async function showcaseDomainAction(
  _previous: ShowcaseActionResult | null,
  form: FormData,
): Promise<ShowcaseActionResult> {
  const assetId = String(form.get('assetId') ?? '');
  const session = await requireSession(`/dashboard/assets/${assetId}`);
  const verb = String(form.get('verb') ?? '');
  const scope = { workspaceId: session.workspace.id, role: session.workspace.role, assetId };
  try {
    if (verb === 'start') await startShowcaseDomain({ ...scope, host: form.get('host') });
    else if (verb === 'check') await checkShowcaseDomain(scope);
    else if (verb === 'remove') await removeShowcaseDomain(scope);
    else return { ok: false, error: 'domain_status' };
    revalidatePath(`/dashboard/assets/${assetId}`);
    return { ok: true };
  } catch (error) {
    return showcaseRefusal(error, `domain ${verb}`);
  }
}

/**
 * Puts the asset into one of the workspace's channels, moves it to another,
 * or takes it out (agent-first-proposal.md 6.1). A plain form post: the page
 * reads the outcome back from `?channel=` -- `moved`, or the refusal's code
 * (`rights_required`, `claim_required`...), which it words.
 */
export async function moveAssetAction(form: FormData): Promise<void> {
  const assetId = String(form.get('assetId') ?? '');
  const session = await requireSession(`/dashboard/assets/${assetId}`);
  const target = String(form.get('channelId') ?? '');
  let outcome = 'moved';
  try {
    await moveAsset({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      assetId: assetId,
      channelId: target === '' ? null : target,
    });
    revalidatePath(`/dashboard/assets/${assetId}`);
    revalidatePath('/dashboard/assets');
    revalidatePath('/dashboard/channels');
  } catch (error) {
    if (error instanceof ChannelRefused) outcome = error.code;
    else if (error instanceof AppError && error.code === 'access_denied') outcome = 'access_denied';
    else {
      console.error(`move asset failed: ${error instanceof Error ? error.message : 'unknown'}`);
      outcome = 'unavailable';
    }
  }
  redirect(`/dashboard/assets/${assetId}?channel=${outcome}#channel`);
}
