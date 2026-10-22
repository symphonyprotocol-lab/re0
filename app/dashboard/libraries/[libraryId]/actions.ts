'use server';

import { revalidatePath } from 'next/cache';
import { after } from 'next/server';
import { AppError } from '@/contracts/errors';
import { runOperation } from '@/lib/application/ingestion';
import {
  addOwnerEvalQuestion,
  applyOwnerLifecycleAction,
  declareLibraryRights,
  editLibraryMetadata,
  removeOwnerEvalQuestion,
  requestLibraryRebuild,
  updateParseScope,
} from '@/lib/application/libraries';
import type { LifecycleStatus } from '@/lib/domain';
import {
  isOwnerLifecycleAction,
  PlatformLibraryRefused,
  type OwnerLifecycleAction,
} from '@/lib/domain/library';
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
import { applyForExpertTag, withdrawExpertApplication } from '@/lib/application/expert-libraries';
import { ExpertLibraryRefused, type ExpertLibraryError } from '@/lib/domain/expert-library';
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
export interface RebuildLibraryActionResult {
  ok: boolean;
  /** False when a pending build was already waiting. */
  created?: boolean;
  error?: 'not_found' | 'access_denied' | 'invalid' | 'quota' | 'unavailable';
}

export async function rebuildLibraryAction(
  _previous: RebuildLibraryActionResult | null,
  form: FormData,
): Promise<RebuildLibraryActionResult> {
  const libraryId = String(form.get('libraryId') ?? '');
  const session = await requireSession(`/dashboard/libraries/${libraryId}`);
  try {
    const { operationId, created } = await requestLibraryRebuild({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      libraryId,
    });
    revalidatePath(`/dashboard/libraries/${libraryId}`);
    revalidatePath('/dashboard/libraries');
    /* Run whether this call queued it or found it waiting: a pending row
       nobody has claimed yet is exactly what the owner is asking about, and
       `runOperation` claims conditionally, so a drain that gets there first
       simply wins. */
    {
      after(async () => {
        try {
          await runOperation({ operationId });
        } catch (error) {
          console.error(`library rebuild run failed: ${error instanceof Error ? error.message : 'unknown'}`);
        }
      });
    }
    return { ok: true, created };
  } catch (error) {
    if (error instanceof AppError) {
      if (error.code === 'library_not_found') return { ok: false, error: 'not_found' };
      if (error.code === 'access_denied') return { ok: false, error: 'access_denied' };
      if (error.code === 'invalid_request') return { ok: false, error: 'invalid' };
      if (error.code === 'quota_exceeded') return { ok: false, error: 'quota' };
    }
    console.error(`rebuild library failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return { ok: false, error: 'unavailable' };
  }
}

/**
 * A model review the rules layer queued (lib/application/review/model.ts)
 * runs after the response, like a first build does: the owner sees
 * "submitted" at once, and the model's answer lands in the review log a
 * little later. The drain picks it up if this never runs.
 */
function runOffRequest(operationId: string | null | undefined): void {
  if (!operationId) return;
  after(async () => {
    try {
      await runOperation({ operationId });
    } catch (error) {
      console.error(`model review run failed: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  });
}

/* ------------------------------------------------------ owner management */

/**
 * The owner's verbs beside rebuild (requirement.md 5.2): pause, resume and
 * resubmit, each answering with where the library now is. The use case
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
  const libraryId = String(form.get('libraryId') ?? '');
  const action = String(form.get('action') ?? '');
  const session = await requireSession(`/dashboard/libraries/${libraryId}`);
  if (!isOwnerLifecycleAction(action)) return { ok: false, error: 'invalid' };
  try {
    const result = await applyOwnerLifecycleAction({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      libraryId,
      action,
    });
    runOffRequest(result.modelReviewOperationId);
    revalidatePath(`/dashboard/libraries/${libraryId}`);
    revalidatePath('/dashboard/libraries');
    return {
      ok: true,
      action,
      lifecycleStatus: result.lifecycleStatus,
      cancelledOperations: result.cancelledOperations,
    };
  } catch (error) {
    if (error instanceof AppError) {
      if (error.code === 'library_not_found') return { ok: false, error: 'not_found' };
      if (error.code === 'access_denied') return { ok: false, error: 'access_denied' };
      if (error.code === 'invalid_request') return { ok: false, error: 'invalid' };
    }
    console.error(`${action} library failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return { ok: false, error: 'unavailable' };
  }
}

/** Edit title, description, language and visibility. */
export interface EditLibraryMetadataActionResult {
  ok: boolean;
  lifecycleStatus?: LifecycleStatus;
  /** True when the visibility change queued the library for review. */
  queuedForReview?: boolean;
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
 * The owner's submission materials (review-visibility-proposal.md 5):
 * declare rights, add and remove self-check questions. One result shape;
 * the panel shows the line for the refusal.
 */
export interface MaterialsActionResult {
  ok: boolean;
  error?:
    | 'not_found'
    | 'access_denied'
    | 'invalid'
    | 'rights_invalid'
    | 'rights_generated'
    | 'question_invalid'
    | 'question_limit'
    | 'unavailable';
}

function materialsRefusal(error: unknown, verb: string): MaterialsActionResult {
  if (error instanceof PlatformLibraryRefused) {
    if (error.code === 'rights_invalid' || error.code === 'rights_required') return { ok: false, error: 'rights_invalid' };
    if (error.code === 'rights_generated') return { ok: false, error: 'rights_generated' };
    if (error.code === 'eval_question_invalid') return { ok: false, error: 'question_invalid' };
    if (error.code === 'eval_question_limit') return { ok: false, error: 'question_limit' };
  }
  if (error instanceof AppError) {
    if (error.code === 'library_not_found') return { ok: false, error: 'not_found' };
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
  const libraryId = String(form.get('libraryId') ?? '');
  const session = await requireSession(`/dashboard/libraries/${libraryId}`);
  try {
    await declareLibraryRights({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      libraryId,
      userId: session.user.id,
      rights: rightsOf(form),
    });
    revalidatePath(`/dashboard/libraries/${libraryId}`);
    revalidatePath('/dashboard/libraries');
    return { ok: true };
  } catch (error) {
    return materialsRefusal(error, 'declare rights');
  }
}

export async function addOwnerEvalQuestionAction(
  _previous: MaterialsActionResult | null,
  form: FormData,
): Promise<MaterialsActionResult> {
  const libraryId = String(form.get('libraryId') ?? '');
  const session = await requireSession(`/dashboard/libraries/${libraryId}`);
  try {
    await addOwnerEvalQuestion({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      libraryId,
      question: String(form.get('question') ?? ''),
      expectedSource: String(form.get('expectedSource') ?? ''),
      expectedText: String(form.get('expectedText') ?? ''),
    });
    revalidatePath(`/dashboard/libraries/${libraryId}`);
    return { ok: true };
  } catch (error) {
    return materialsRefusal(error, 'add question');
  }
}

export async function removeOwnerEvalQuestionAction(
  _previous: MaterialsActionResult | null,
  form: FormData,
): Promise<MaterialsActionResult> {
  const libraryId = String(form.get('libraryId') ?? '');
  const session = await requireSession(`/dashboard/libraries/${libraryId}`);
  try {
    await removeOwnerEvalQuestion({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      libraryId,
      questionId: String(form.get('questionId') ?? ''),
    });
    revalidatePath(`/dashboard/libraries/${libraryId}`);
    return { ok: true };
  } catch (error) {
    return materialsRefusal(error, 'remove question');
  }
}

export async function editLibraryMetadataAction(
  _previous: EditLibraryMetadataActionResult | null,
  form: FormData,
): Promise<EditLibraryMetadataActionResult> {
  const libraryId = String(form.get('libraryId') ?? '');
  const session = await requireSession(`/dashboard/libraries/${libraryId}`);
  try {
    const result = await editLibraryMetadata({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      libraryId,
      userId: session.user.id,
      title: String(form.get('title') ?? ''),
      description: String(form.get('description') ?? ''),
      language: String(form.get('language') ?? ''),
      visibility: String(form.get('visibility') ?? ''),
      rights: rightsOf(form),
    });
    runOffRequest(result.modelReviewOperationId);
    revalidatePath(`/dashboard/libraries/${libraryId}`);
    revalidatePath('/dashboard/libraries');
    return { ok: true, lifecycleStatus: result.lifecycleStatus, queuedForReview: result.queuedForReview };
  } catch (error) {
    if (error instanceof PlatformLibraryRefused) {
      if (error.code === 'invalid_title') return { ok: false, error: 'invalid_title' };
      if (error.code === 'archived') return { ok: false, error: 'archived' };
      if (error.code === 'rights_required' || error.code === 'rights_invalid') return { ok: false, error: 'rights_required' };
      if (error.code === 'rights_generated') return { ok: false, error: 'rights_generated' };
      return { ok: false, error: 'invalid_metadata' };
    }
    if (error instanceof AppError) {
      if (error.code === 'library_not_found') return { ok: false, error: 'not_found' };
      if (error.code === 'access_denied') return { ok: false, error: 'access_denied' };
      if (error.code === 'invalid_request') return { ok: false, error: 'invalid_metadata' };
    }
    console.error(`edit library failed: ${error instanceof Error ? error.message : 'unknown'}`);
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
  const libraryId = String(form.get('libraryId') ?? '');
  const session = await requireSession(`/dashboard/libraries/${libraryId}`);
  try {
    const result = await updateParseScope({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      libraryId,
      folders: String(form.get('folders') ?? ''),
      excludeFolders: String(form.get('excludeFolders') ?? ''),
      excludeFiles: String(form.get('excludeFiles') ?? ''),
      indexDepth: String(form.get('indexDepth') ?? ''),
      refreshPolicy: String(form.get('refreshPolicy') ?? ''),
    });
    revalidatePath(`/dashboard/libraries/${libraryId}`);
    return { ok: true, rebuildAdvised: result.rebuildAdvised };
  } catch (error) {
    if (error instanceof PlatformLibraryRefused) {
      if (error.code === 'unsupported_source') return { ok: false, error: 'unsupported' };
      if (error.code === 'invalid_refresh_policy') return { ok: false, error: 'invalid_refresh_policy' };
      return { ok: false, error: 'invalid_scope', detail: error.message };
    }
    if (error instanceof AppError) {
      if (error.code === 'library_not_found') return { ok: false, error: 'not_found' };
      if (error.code === 'access_denied') return { ok: false, error: 'access_denied' };
      if (error.code === 'invalid_request') return { ok: false, error: 'invalid_scope' };
    }
    console.error(`configure library failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return { ok: false, error: 'unavailable' };
  }
}

/* ------------------------------------------------------------ site keys */

/**
 * The website widget's keys (requirement.md 9.4). Three verbs, one result
 * shape: the form shows the key that was created or saved, or names the
 * field that was refused. The use cases re-check the role and that the
 * library is this workspace's.
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
    if (error.code === 'library_not_found') return { ok: false, error: 'not_found' };
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
  const libraryId = String(form.get('libraryId') ?? '');
  const session = await requireSession(`/dashboard/libraries/${libraryId}`);
  try {
    await createSiteKey({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      libraryId,
      ...siteKeySettings(form),
    });
    revalidatePath(`/dashboard/libraries/${libraryId}`);
    return { ok: true };
  } catch (error) {
    return siteKeyRefusal(error, 'create');
  }
}

export async function updateSiteKeyAction(
  _previous: SiteKeyActionResult | null,
  form: FormData,
): Promise<SiteKeyActionResult> {
  const libraryId = String(form.get('libraryId') ?? '');
  const siteKeyId = String(form.get('siteKeyId') ?? '');
  const session = await requireSession(`/dashboard/libraries/${libraryId}`);
  try {
    await updateSiteKey({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      siteKeyId,
      ...siteKeySettings(form),
    });
    revalidatePath(`/dashboard/libraries/${libraryId}`);
    return { ok: true };
  } catch (error) {
    return siteKeyRefusal(error, 'update');
  }
}

export async function revokeSiteKeyAction(
  _previous: SiteKeyActionResult | null,
  form: FormData,
): Promise<SiteKeyActionResult> {
  const libraryId = String(form.get('libraryId') ?? '');
  const siteKeyId = String(form.get('siteKeyId') ?? '');
  const session = await requireSession(`/dashboard/libraries/${libraryId}`);
  try {
    await revokeSiteKey({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      siteKeyId,
    });
    revalidatePath(`/dashboard/libraries/${libraryId}`);
    return { ok: true };
  } catch (error) {
    return siteKeyRefusal(error, 'revoke');
  }
}

/* ------------------------------------------------------- expert library */

/**
 * The owner's two moves over the expert tag (expert-library-prd.md 5): open
 * an application, or withdraw the pending one. The use case re-checks the
 * role and reads every precondition under the library's row lock; the panel
 * only decides what is drawn, and the refusal codes it gets back are the
 * domain's own so the dictionary can name each missing condition.
 */
export interface ExpertApplicationActionResult {
  ok: boolean;
  action?: 'apply' | 'withdraw';
  error?: ExpertLibraryError | 'unavailable';
}

export async function applyExpertAction(
  _previous: ExpertApplicationActionResult | null,
  form: FormData,
): Promise<ExpertApplicationActionResult> {
  const libraryId = String(form.get('libraryId') ?? '');
  const session = await requireSession(`/dashboard/libraries/${libraryId}`);
  try {
    await applyForExpertTag({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      libraryId,
      materials: {
        scope: form.get('scope'),
        maintenance: form.get('maintenance'),
        credentials: form.get('credentials'),
        note: form.get('note'),
      },
      userId: session.user.id,
    });
    revalidatePath(`/dashboard/libraries/${libraryId}`);
    return { ok: true, action: 'apply' };
  } catch (error) {
    if (error instanceof ExpertLibraryRefused) return { ok: false, error: error.code };
    console.error(`expert application failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return { ok: false, error: 'unavailable' };
  }
}

export async function withdrawExpertAction(
  _previous: ExpertApplicationActionResult | null,
  form: FormData,
): Promise<ExpertApplicationActionResult> {
  const libraryId = String(form.get('libraryId') ?? '');
  const session = await requireSession(`/dashboard/libraries/${libraryId}`);
  try {
    await withdrawExpertApplication({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      libraryId,
      userId: session.user.id,
    });
    revalidatePath(`/dashboard/libraries/${libraryId}`);
    return { ok: true, action: 'withdraw' };
  } catch (error) {
    if (error instanceof ExpertLibraryRefused) return { ok: false, error: error.code };
    console.error(`expert withdrawal failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return { ok: false, error: 'unavailable' };
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
    if (error.code === 'library_not_found') return { ok: false, error: 'not_found' };
    if (error.code === 'quota_exceeded') return { ok: false, error: 'quota' };
  }
  console.error(`${verb} faq entry failed: ${error instanceof Error ? error.message : 'unknown'}`);
  return { ok: false, error: 'unavailable' };
}

export async function saveFaqEntryAction(
  _previous: FaqActionResult | null,
  form: FormData,
): Promise<FaqActionResult> {
  const libraryId = String(form.get('libraryId') ?? '');
  const session = await requireSession(`/dashboard/libraries/${libraryId}`);
  try {
    const entryId = String(form.get('entryId') ?? '');
    const result = await saveFaqEntry({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      libraryId,
      entryId: entryId.length > 0 ? entryId : null,
      question: String(form.get('question') ?? ''),
      answer: String(form.get('answer') ?? ''),
      pageUrl: String(form.get('pageUrl') ?? ''),
    });
    after(() => runOperation({ operationId: result.operationId }));
    revalidatePath(`/dashboard/libraries/${libraryId}`);
    return { ok: true };
  } catch (error) {
    return faqRefusal(error, 'save');
  }
}

export async function deleteFaqEntryAction(
  _previous: FaqActionResult | null,
  form: FormData,
): Promise<FaqActionResult> {
  const libraryId = String(form.get('libraryId') ?? '');
  const session = await requireSession(`/dashboard/libraries/${libraryId}`);
  try {
    const result = await deleteFaqEntry({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      libraryId,
      entryId: String(form.get('entryId') ?? ''),
    });
    after(() => runOperation({ operationId: result.operationId }));
    revalidatePath(`/dashboard/libraries/${libraryId}`);
    return { ok: true };
  } catch (error) {
    return faqRefusal(error, 'delete');
  }
}

/* --------------------------------------------------------------- showcase */

/**
 * The library's showcase page (lib/domain/showcase.ts): enable one, edit
 * what it says, draft it from the library, publish, disable, restore, and
 * the logo and screenshot. One result shape: the form shows what changed
 * or names the field that was refused. The use cases re-check the role and
 * that the library is this workspace's.
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
    if (error.code === 'library_not_found') return { ok: false, error: 'not_found' };
    if (error.code === 'library_not_ready') return { ok: false, error: 'not_ready' };
    if (error.code === 'quota_exceeded') return { ok: false, error: 'quota' };
    if (error.code === 'rate_limited') return { ok: false, error: 'rate_limited' };
  }
  console.error(`${verb} showcase failed: ${error instanceof Error ? error.message : 'unknown'}`);
  return { ok: false, error: 'unavailable' };
}

function revalidateShowcase(libraryId: string, slug?: string): void {
  revalidatePath(`/dashboard/libraries/${libraryId}`);
  if (slug) revalidatePath(`/s/${slug}`);
}

/** Enable the page and draft it from the library in one go; a draft that cannot run leaves the page enabled and empty. */
export async function enableShowcaseAction(
  _previous: ShowcaseActionResult | null,
  form: FormData,
): Promise<ShowcaseActionResult> {
  const libraryId = String(form.get('libraryId') ?? '');
  const session = await requireSession(`/dashboard/libraries/${libraryId}`);
  try {
    const { locale } = await translations();
    const { showcase, created } = await enableShowcase({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      libraryId,
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
            libraryId,
            requestId: newRequestId(),
          })
        ).outcome;
      } catch (error) {
        console.warn(`showcase first draft skipped: ${error instanceof Error ? error.message : 'unknown'}`);
      }
    }
    revalidateShowcase(libraryId, showcase.slug);
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
  const libraryId = String(form.get('libraryId') ?? '');
  const session = await requireSession(`/dashboard/libraries/${libraryId}`);
  try {
    const titles = form.getAll('featureTitle').map(String);
    const bodies = form.getAll('featureBody').map(String);
    const showcase = await updateShowcase({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      libraryId,
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
    revalidateShowcase(libraryId, showcase.slug);
    return { ok: true };
  } catch (error) {
    return showcaseRefusal(error, 'update');
  }
}

/** Draft the page from the library again: the generated fields, or every shown field when `overwrite` is set. */
export async function draftShowcaseAction(
  _previous: ShowcaseActionResult | null,
  form: FormData,
): Promise<ShowcaseActionResult> {
  const libraryId = String(form.get('libraryId') ?? '');
  const session = await requireSession(`/dashboard/libraries/${libraryId}`);
  try {
    const result = await generateShowcaseDraft({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      libraryId,
      overwrite: form.get('overwrite') === 'true',
      requestId: newRequestId(),
    });
    revalidateShowcase(libraryId, result.showcase.slug);
    return { ok: true, draft: result.outcome };
  } catch (error) {
    return showcaseRefusal(error, 'draft');
  }
}

export async function showcaseVerbAction(
  _previous: ShowcaseActionResult | null,
  form: FormData,
): Promise<ShowcaseActionResult> {
  const libraryId = String(form.get('libraryId') ?? '');
  const session = await requireSession(`/dashboard/libraries/${libraryId}`);
  try {
    const showcase = await applyShowcaseVerb({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      libraryId,
      verb: String(form.get('verb') ?? ''),
    });
    revalidateShowcase(libraryId, showcase.slug);
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
  const libraryId = String(form.get('libraryId') ?? '');
  const slug = String(form.get('slug') ?? '');
  const session = await requireSession(`/dashboard/libraries/${libraryId}`);
  try {
    await deleteShowcase({ workspaceId: session.workspace.id, role: session.workspace.role, libraryId });
    revalidateShowcase(libraryId, slug || undefined);
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
  const libraryId = String(form.get('libraryId') ?? '');
  const session = await requireSession(`/dashboard/libraries/${libraryId}`);
  try {
    const kind = form.get('kind') === 'screenshot' ? 'screenshot' : 'logo';
    const file = form.get('file');
    if (form.get('remove') === 'true') {
      const showcase = await removeShowcaseAsset({ workspaceId: session.workspace.id, role: session.workspace.role, libraryId, kind });
      revalidateShowcase(libraryId, showcase.slug);
      return { ok: true };
    }
    if (!(file instanceof File) || file.size === 0) return { ok: false, error: 'asset_size' };
    const showcase = await uploadShowcaseAsset({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      libraryId,
      kind,
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
    revalidateShowcase(libraryId, showcase.slug);
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
  const libraryId = String(form.get('libraryId') ?? '');
  const session = await requireSession(`/dashboard/libraries/${libraryId}`);
  try {
    await updateShowcaseLead({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      libraryId,
      leadId: String(form.get('leadId') ?? ''),
      verb: String(form.get('verb') ?? ''),
    });
    revalidatePath(`/dashboard/libraries/${libraryId}`);
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
  const libraryId = String(form.get('libraryId') ?? '');
  const session = await requireSession(`/dashboard/libraries/${libraryId}`);
  const verb = String(form.get('verb') ?? '');
  const scope = { workspaceId: session.workspace.id, role: session.workspace.role, libraryId };
  try {
    if (verb === 'start') await startShowcaseDomain({ ...scope, host: form.get('host') });
    else if (verb === 'check') await checkShowcaseDomain(scope);
    else if (verb === 'remove') await removeShowcaseDomain(scope);
    else return { ok: false, error: 'domain_status' };
    revalidatePath(`/dashboard/libraries/${libraryId}`);
    return { ok: true };
  } catch (error) {
    return showcaseRefusal(error, `domain ${verb}`);
  }
}
