'use server';

import { after } from 'next/server';
import { AppError } from '@/contracts/errors';
import { runOperation } from '@/lib/application/ingestion';
import {
  GithubImportRefused,
  NotionImportRefused,
  type GithubImportRefusalCode,
  type NotionImportRefusalCode,
} from '@/lib/application/auth';
import {
  checkDomainVerification,
  createWorkspaceLibrary,
  prepareUploads,
  startDomainVerification,
  type DomainChallenge,
  type PreparedUpload,
} from '@/lib/application/libraries';
import type { DomainVerificationFailure } from '@/lib/domain/domain-verification';
import { isConnectedSourceType, isUploadSourceType, PlatformLibraryRefused, UPLOAD_LIMITS } from '@/lib/domain/library';
import { requireSession } from '@/lib/http/session';

/**
 * The wizard's one mutation. Re-resolves the session like every action -- a
 * server action is a public endpoint with a generated name -- and returns a
 * coarse error code the wizard translates; detail stays server side.
 */
export interface CreateLibraryResult {
  ok: boolean;
  publicId?: string;
  /** Where the files page of a PDF library created without files is. */
  libraryId?: string;
  error?:
    | 'invalid'
    | 'taken'
    | 'quota'
    | 'denied'
    | 'unavailable'
    | 'github'
    | 'notion'
    | 'unverified'
    /** A public library without a usable rights declaration, or one declaring model-generated content. */
    | 'rights';
  /** With `error: 'github'`: which import rule the repository failed. */
  refusal?: GithubImportRefusalCode;
  /** With `error: 'notion'`: why the page could not be imported. */
  notionRefusal?: NotionImportRefusalCode;
  /** With `error: 'unverified'`: why the domain challenge could not be spent. */
  reason?: DomainVerificationFailure;
}

export async function createWorkspaceLibraryAction(
  _previous: CreateLibraryResult | null,
  form: FormData,
): Promise<CreateLibraryResult> {
  const session = await requireSession('/dashboard/libraries/new');
  try {
    const sourceType = String(form.get('sourceType') ?? '');
    if (!isConnectedSourceType(sourceType)) return { ok: false, error: 'invalid' };
    const visibility = form.get('visibility') === 'private' ? 'private' : 'public';

    /* The wizard posts an empty manifest field when no file was uploaded;
       that is an empty upload library, filled in from its files page. */
    let uploads: unknown;
    const posted = String(form.get('uploads') ?? '');
    if (isUploadSourceType(sourceType) && posted !== '') {
      try {
        uploads = JSON.parse(posted);
      } catch {
        return { ok: false, error: 'invalid' };
      }
    }

    const { publicId, libraryId, operationId } = await createWorkspaceLibrary({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      userId: session.user.id,
      title: String(form.get('title') ?? ''),
      visibility,
      sourceType,
      location: String(form.get('location') ?? ''),
      slug: String(form.get('slug') ?? ''),
      uploads,
      indexDepth: String(form.get('indexDepth') ?? ''),
      domainVerificationId: String(form.get('domainVerificationId') ?? '') || undefined,
      description: String(form.get('description') ?? '') || null,
      language: String(form.get('language') ?? '') || null,
      rights: {
        origin: form.get('rightsOrigin') ?? undefined,
        license: form.get('rightsLicense') ?? undefined,
        generation: form.get('rightsGeneration') ?? undefined,
        note: form.get('rightsNote') ?? undefined,
      },
    });
    /* Queued, and then run after the response: the wizard says "queued" at
       once, and by the time the owner opens the library page the first build
       has usually finished. A drain that overlaps loses the claim and does
       nothing; a failure lands on the operation row, not here. */
    if (operationId) {
      after(async () => {
        try {
          await runOperation({ operationId });
        } catch (error) {
          console.error(`library build run failed: ${error instanceof Error ? error.message : 'unknown'}`);
        }
      });
    }
    return { ok: true, publicId, libraryId };
  } catch (error) {
    if (error instanceof PlatformLibraryRefused && error.code.startsWith('rights_')) {
      return { ok: false, error: 'rights' };
    }
    if (error instanceof GithubImportRefused) {
      return { ok: false, error: 'github', refusal: error.refusal };
    }
    if (error instanceof NotionImportRefused) {
      return { ok: false, error: 'notion', notionRefusal: error.refusal };
    }
    if (error instanceof AppError && error.code === 'claim_verification_failed') {
      return { ok: false, error: 'unverified', reason: verificationReason(error.reason) };
    }
    /* requirement.md 3.3: only an owner or admin creates a library. The page
       says so before the wizard starts, but the action is a public endpoint
       and a refusal here is a refusal, not an outage. */
    if (error instanceof AppError && error.code === 'access_denied') {
      return { ok: false, error: 'denied' };
    }
    if (error instanceof AppError && error.code === 'quota_exceeded') {
      return { ok: false, error: 'quota' };
    }
    if (error instanceof AppError && error.code === 'invalid_request') {
      return { ok: false, error: error.message.includes('taken') ? 'taken' : 'invalid' };
    }
    if (error instanceof AppError && error.code === 'provider_unavailable') {
      return { ok: false, error: 'unavailable' };
    }
    console.error(`create library failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return { ok: false, error: 'unavailable' };
  }
}

/**
 * Room in the store for the files the wizard is about to upload -- PDFs, or
 * Markdown/MDX when `kind` says so: one upload ticket per file. The browser uploads straight to storage, so a 20 MB
 * manual never passes through a server action and its body limit.
 * Returns a coarse code like the create action; the size limit is repeated
 * in the result so the wizard can say it without a second round trip.
 */
export interface PrepareUploadResult {
  ok: boolean;
  batchId?: string;
  files?: PreparedUpload[];
  maxFileBytes: number;
  error?: 'invalid' | 'too_large' | 'access_denied' | 'unavailable';
}

export async function prepareUploadAction(
  files: { name: string; size: number }[],
  batchId?: string,
  kind?: string,
): Promise<PrepareUploadResult> {
  /* Shared with the library files page, which hands the same action to the
     same uploader; the session is what matters, not the page. */
  const session = await requireSession('/dashboard/libraries');
  const maxFileBytes = UPLOAD_LIMITS.maxFileBytes;
  if (!Array.isArray(files) || files.length > UPLOAD_LIMITS.maxFiles) {
    return { ok: false, maxFileBytes, error: 'invalid' };
  }
  try {
    const prepared = await prepareUploads({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      files: files.map((file) => ({ name: String(file?.name ?? ''), size: Number(file?.size) })),
      batchId: typeof batchId === 'string' ? batchId : undefined,
      /* Anything but a known kind is a PDF: the default the store always took. */
      kind: isUploadSourceType(kind) ? kind : 'pdf',
    });
    return { ok: true, maxFileBytes, ...prepared };
  } catch (error) {
    if (error instanceof AppError) {
      if (error.code === 'library_size_exceeded') return { ok: false, maxFileBytes, error: 'too_large' };
      if (error.code === 'access_denied') return { ok: false, maxFileBytes, error: 'access_denied' };
      if (error.code === 'invalid_request') return { ok: false, maxFileBytes, error: 'invalid' };
    }
    console.error(`prepare upload failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return { ok: false, maxFileBytes, error: 'unavailable' };
  }
}

/* ------------------------------------------------------ domain challenges */

/**
 * The domain challenge (requirement.md 7.3.2) the wizard walks a website,
 * llms.txt or OpenAPI library through before it may be created. Two calls:
 * start hands back the one plaintext copy of the token with where to put it;
 * check asks DNS or the host and says whether it was found. Both answer with
 * stable codes only -- no DNS payload, no fetched body (requirement.md 7.3.7).
 */
export interface StartDomainVerificationResult {
  ok: boolean;
  challenge?: Omit<DomainChallenge, 'expiresAt'> & { expiresAt: string };
  error?: 'invalid' | 'access_denied' | 'retry_limit_exceeded' | 'unavailable';
}

export async function startDomainVerificationAction(input: {
  sourceType: string;
  location: string;
  method: string;
}): Promise<StartDomainVerificationResult> {
  const session = await requireSession('/dashboard/libraries/new');
  const sourceType = String(input?.sourceType ?? '');
  if (!isConnectedSourceType(sourceType)) return { ok: false, error: 'invalid' };
  try {
    const challenge = await startDomainVerification({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      sourceType,
      location: String(input?.location ?? ''),
      method: String(input?.method ?? ''),
    });
    return { ok: true, challenge: { ...challenge, expiresAt: challenge.expiresAt.toISOString() } };
  } catch (error) {
    if (error instanceof AppError) {
      if (error.code === 'invalid_request') return { ok: false, error: 'invalid' };
      if (error.code === 'access_denied') return { ok: false, error: 'access_denied' };
      if (error.code === 'claim_verification_failed') return { ok: false, error: 'retry_limit_exceeded' };
    }
    console.error(`start domain verification failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return { ok: false, error: 'unavailable' };
  }
}

export interface CheckDomainVerificationResult {
  ok: boolean;
  host?: string;
  reason?: DomainVerificationFailure;
  error?: 'access_denied' | 'unavailable';
}

export async function checkDomainVerificationAction(input: {
  verificationId: string;
  token: string;
}): Promise<CheckDomainVerificationResult> {
  const session = await requireSession('/dashboard/libraries/new');
  try {
    const result = await checkDomainVerification({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      verificationId: String(input?.verificationId ?? ''),
      token: String(input?.token ?? ''),
    });
    return result.ok ? { ok: true, host: result.host } : { ok: false, reason: result.reason };
  } catch (error) {
    if (error instanceof AppError && error.code === 'access_denied') {
      return { ok: false, error: 'access_denied' };
    }
    console.error(`check domain verification failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return { ok: false, error: 'unavailable' };
  }
}

function verificationReason(reason: string | undefined): DomainVerificationFailure {
  switch (reason) {
    case 'challenge_expired':
    case 'retry_limit_exceeded':
    case 'source_mismatch':
      return reason;
    default:
      return 'challenge_not_found';
  }
}
