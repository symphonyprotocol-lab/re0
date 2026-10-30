/**
 * A workspace creates its own asset. requirement.md 7.1, architecture.md
 * 8.4: creation writes the rows and queues the build -- the request never
 * waits for ingestion, which runs through the same workflow queue refreshes
 * use.
 *
 * Ownership vs rights, deliberately split: `owner_workspace_id` is set to the
 * creator so the dashboard and the owner's own reads work, but that is
 * *access*, not *rights*. Sources that requirement.md 7.3 gates behind a claim (github,
 * website) hold their rights only once a claim verifies -- checked where
 * rights are read, not here.
 *
 * For a website, the one source fetched from a host, control of that host is
 * proven *before* the asset exists: the wizard
 * starts a domain challenge (domain-verification.ts) and creation refuses
 * anything but a verified, unspent challenge for the source's host. The
 * challenge is spent here, inside the same transaction that writes the rows,
 * and copied onto `asset_claim` so the asset is born claimed.
 */
import { and, eq } from 'drizzle-orm';
import { AppError } from '@/contracts/errors';
import { uuidv7 } from '@/lib/domain/id';
import {
  idNamespace,
  isConnectedSourceType,
  isUploadSourceType,
  assetDescription,
  assetLanguage,
  normalizeLocation,
  normalizePublicId,
  parseIndexDepth,
  parseUploadManifest,
  PlatformAssetRefused,
  uploadPrefix,
  type ConnectedSourceType,
  type UploadedFile,
} from '@/lib/domain/asset';
import { checkGithubImport, type CheckGithubImport } from '@/lib/application/auth/github-connection';
import { checkNotionImport, type CheckNotionImport } from '@/lib/application/auth/notion-connection';
import { NOTION_SOURCE_USER_KEY } from '@/lib/domain/notion';
import { parseRightsDeclaration, rightsPosted, type RightsDeclaration } from '@/lib/domain/rights';
import { requiresDomainVerification } from '@/lib/domain/domain-verification';
import { assetKindOf } from '@/lib/domain/asset-kind';
import { hasReservedOwner } from '@/lib/domain/reserved-names';
import { consumeDomainVerification } from './domain-verification';
import { isObjectStoreConfigured, objectStore, type ObjectStore } from '@/lib/infrastructure/objects/store';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { canManageAssets, type WorkspaceRole } from './delete';
import { assertBuildAffordable } from '@/lib/application/plans/build-quota';

export interface CreateWorkspaceAssetInput {
  workspaceId: string;
  role: WorkspaceRole;
  /**
   * The signed-in account. Required for github, whose repository must be
   * one this person owns on GitHub (lib/domain/github.ts), and for notion,
   * whose page is read with this person's own grant (lib/domain/notion.ts);
   * both checks read a connected grant that belongs to the user, not the
   * workspace.
   */
  userId?: string;
  title: string;
  sourceType: ConnectedSourceType;
  /** Ignored for pdf and markdown, whose location is where their uploads sit. */
  location: string;
  /** Ignored for github, whose id is the repository. */
  slug: string;
  /**
   * For pdf and markdown only: the manifest the wizard posted after
   * uploading, as parsed JSON. Checked against this workspace's key prefix
   * and against the store before a row is written, because a form post can
   * say anything. Absent, or a manifest with no files, creates an empty
   * upload asset: the files come later through `updateAssetFiles`, and
   * no build is queued until they do.
   */
  uploads?: unknown;
  /** For website: how many child-page levels to follow. */
  indexDepth?: unknown;
  /**
   * For website: the verified domain challenge for the source's host, as
   * `startDomainVerification` issued it and `checkDomainVerification`
   * verified it. Required for that type; spent on this asset.
   */
  domainVerificationId?: unknown;
  description?: string | null;
  language?: string | null;
  /**
   * The owner's rights declaration (lib/domain/rights.ts), as the wizard
   * posts it. Optional here: a new asset is in no channel and so its
   * owner's alone; the declaration is checked when it moves into a public
   * channel (channels/move.ts, agent-first-proposal.md 6.11).
   */
  rights?: { origin?: unknown; license?: unknown; generation?: unknown; note?: unknown };
  /** The store the uploads are confirmed in; the configured one by default. */
  store?: Pick<ObjectStore, 'head'>;
  /** The repository check for github; GitHub itself by default. */
  checkRepository?: CheckGithubImport;
  /** The page check for notion; Notion itself by default. */
  checkPage?: CheckNotionImport;
}

export interface CreateWorkspaceAssetResult {
  assetId: string;
  publicId: string;
  /** The queued first build. Null for an upload asset created without files. */
  operationId: string | null;
}

export async function createWorkspaceAsset(
  input: CreateWorkspaceAssetInput,
): Promise<CreateWorkspaceAssetResult> {
  /* Checked first, before any validation reveals anything: requirement.md 3.3
     gives asset management to owners and admins, and the delete verb has
     always enforced it. Creating one is the same right. */
  if (!canManageAssets(input.role)) {
    throw new AppError('access_denied', 'only a workspace owner or admin can create an asset');
  }

  const title = input.title.trim();
  if (title.length === 0 || title.length > 120) {
    throw new AppError('invalid_request', 'an asset needs a title (1-120 characters)');
  }

  /*
   * The same rule the metadata form applies (`editWorkspaceAsset`), not a
   * second set of numbers: the wizard's `maxLength` attributes are a courtesy
   * to the person typing, and the action behind them is a public endpoint.
   * Without this a description longer than the edit path allows was stored,
   * published, and then unsavable through the only form that could shorten it.
   */
  let description: string | null;
  let language: string | null;
  try {
    description = assetDescription(input.description);
    language = assetLanguage(input.language);
  } catch (error) {
    if (error instanceof PlatformAssetRefused) {
      throw new AppError('invalid_request', 'the description or language is longer than allowed');
    }
    throw error;
  }

  /*
   * The rights declaration (review-visibility-proposal.md 5.1), when the
   * wizard posted one. Every new asset starts in no channel -- its owner's
   * alone (agent-first-proposal.md 3.3, 6.2) -- so nothing requires it yet;
   * moving into a public channel does.
   */
  let rightsDeclaration: RightsDeclaration | null = null;
  if (input.rights && rightsPosted(input.rights)) {
    rightsDeclaration = parseRightsDeclaration(input.rights, { userId: input.userId ?? null, now: new Date() });
    if (!rightsDeclaration) throw new PlatformAssetRefused('rights_invalid', 'the rights declaration is incomplete');
  }
  if (!isConnectedSourceType(input.sourceType)) {
    throw new AppError('invalid_request', 'unsupported source type');
  }

  /*
   * An upload source's location is derived, not typed: the prefix its files
   * were uploaded under. Each file is confirmed to exist in the store at the
   * size the manifest claims, so a build never starts on an upload that
   * failed halfway or a manifest a client edited.
   */
  const isUpload = isUploadSourceType(input.sourceType);
  let uploaded: UploadedFile[] = [];
  let location: string | null;
  /* What the source row remembers besides its location. */
  let sourceConfig: Record<string, unknown> = {};
  if (isUploadSourceType(input.sourceType)) {
    const manifest =
      input.uploads === undefined || input.uploads === null
        ? { batchId: uuidv7(), files: [] }
        : parseUploadManifest(input.uploads, input.workspaceId, input.sourceType);
    if (!manifest) {
      throw new AppError('invalid_request', 'the upload manifest is not valid');
    }
    uploaded = manifest.files;
    location = uploadPrefix(input.workspaceId, manifest.batchId);
    await confirmUploads(uploaded, input.store);
  } else {
    location = normalizeLocation(input.sourceType, input.location);
  }
  if (!location) {
    throw new AppError('invalid_request', 'the source location is not valid for this source type');
  }

  /*
   * A repository is imported from the person's own GitHub account and from
   * nowhere else: public, not a fork, owned by the account whose grant is on
   * file. The check re-reads the repository with that grant rather than
   * trusting the wizard's list, and the location is rewritten to GitHub's
   * spelling so the asset id follows the repository, not the form post.
   * The repository id is kept on the source for the claim flow to compare
   * against (architecture.md 5.4).
   */
  if (input.sourceType === 'github') {
    /*
     * A repository id is `/{owner}/{repo}` at the root, beside every other
     * namespace and page route; an owner spelled like one of those is
     * refused before GitHub is asked anything (lib/domain/reserved-names.ts,
     * agent-first-proposal.md 3.2). Rare enough to be a support case.
     */
    if (hasReservedOwner(location)) {
      throw new AppError(
        'invalid_request',
        'this GitHub owner name is reserved on re0; contact support to add this repository',
      );
    }
    if (!input.userId) {
      throw new AppError('access_denied', 'a signed-in account is needed to import a repository');
    }
    const check = await (input.checkRepository ?? checkGithubImport)({
      userId: input.userId,
      location,
    });
    location = check.location;
    sourceConfig = { repositoryId: check.repositoryId };
  } else if (input.sourceType === 'notion') {
    /*
     * A Notion page is read with the person's own grant and no other: the
     * check re-reads it with that grant, the location is rewritten to the
     * page's own URL, and the account is remembered on the source so every
     * later build resolves the same grant (build-version.ts). A page the
     * grant cannot see is refused here, not minutes later by the build.
     */
    if (!input.userId) {
      throw new AppError('access_denied', 'a signed-in account is needed to import a Notion page');
    }
    const check = await (input.checkPage ?? checkNotionImport)({
      userId: input.userId,
      location,
    });
    location = check.location;
    sourceConfig = { pageId: check.pageId, [NOTION_SOURCE_USER_KEY]: input.userId };
  } else if (isUpload) {
    sourceConfig = { files: uploaded };
  } else if (input.sourceType === 'website') {
    sourceConfig = { indexDepth: parseIndexDepth(input.indexDepth) };
  }

  const publicId =
    input.sourceType === 'github'
      ? normalizePublicId('github', location)
      : normalizePublicId(input.sourceType, `/${idNamespace(input.sourceType)}/${input.slug.trim().toLowerCase()}`);
  if (!publicId) {
    throw new AppError('invalid_request', 'the asset id is not valid');
  }

  /* Refused before anything is counted or locked: a missing challenge is
     the wizard skipping a step, and the answer should not wait on the plan. */
  if (requiresDomainVerification(input.sourceType) && typeof input.domainVerificationId !== 'string') {
    throw new AppError(
      'claim_verification_failed',
      'the source domain must be verified before this asset is created',
      'challenge_not_found',
    );
  }

  const database = db();

  /*
   * asset-build-billing.md 4.1: a workspace that cannot cover a build's
   * base fee is refused before a row exists, rather than handed an asset
   * whose first build can only fail. Read before the lock: the reservation
   * itself is taken by the worker under the lock. There is no ceiling on
   * how many assets a workspace holds (agent-first-proposal.md 8.1); its
   * content is bounded as a whole, at build time, by the owner's storage tier.
   */
  if (!isUpload || uploaded.length > 0) {
    await assertBuildAffordable({
      workspaceId: input.workspaceId,
      fetchesPages: requiresDomainVerification(input.sourceType),
    });
  }
  const now = new Date();

  const assetId = uuidv7();
  const sourceId = uuidv7();
  /* Nothing to build yet for an empty upload asset; `source_empty` from a
     build that could only fail is not information the operator lacks. */
  const operationId = isUpload && uploaded.length === 0 ? null : uuidv7();

  try {
    await database.transaction(async (tx) => {
      /*
       * Locked, then counted, then inserted -- all in one transaction.
       *
       * The count used to run outside any transaction and the insert in its
       * own, which is the "SELECT the remainder, then plain INSERT" shape
       * architecture.md 11.1 forbids and `reserveCall` avoids the same way:
       * two wizard submits arriving together both read the old count, both
       * pass the ceiling, and the workspace ends up over its plan's limit
       * with no constraint to catch it.
       */
      const [locked] = await tx
        .select({ id: schema.workspace.id })
        .from(schema.workspace)
        .where(eq(schema.workspace.id, input.workspaceId))
        .for('update');
      if (!locked) throw new AppError('access_denied', 'no such workspace');

      await tx.insert(schema.asset).values({
        id: assetId,
        publicId,
        title,
        description,
        language,
        ownerWorkspaceId: input.workspaceId,
        isPlatformAsset: false,
        kind: assetKindOf(input.sourceType),
        lifecycleStatus: 'draft',
        indexStatus: 'pending',
        rightsDeclaration,
      });
      await tx.insert(schema.source).values({
        id: sourceId,
        assetId,
        type: input.sourceType,
        location,
        config: sourceConfig,
      });
      if (requiresDomainVerification(input.sourceType)) {
        await consumeDomainVerification(tx, {
          workspaceId: input.workspaceId,
          verificationId: input.domainVerificationId,
          location: location!,
          assetId,
          now,
        });
      }
      if (operationId) {
        await tx.insert(schema.workflowOperation).values({
          id: operationId,
          assetId,
          operationType: 'ingest',
          sourceDigest: null,
          status: 'pending',
        });
      }
    });
  } catch (error) {
    /* The driver wraps the pg error; the constraint name sits on the cause. */
    const messages = [
      error instanceof Error ? error.message : '',
      error instanceof Error && error.cause instanceof Error ? error.cause.message : '',
    ].join(' ');
    if (messages.includes('asset_public_id_uq')) {
      throw new AppError('invalid_request', 'that asset id is already taken');
    }
    throw error;
  }

  return { assetId, publicId, operationId };
}

export async function confirmUploads(
  files: UploadedFile[],
  store?: Pick<ObjectStore, 'head'>,
): Promise<void> {
  if (files.length === 0) return;
  if (!store && !isObjectStoreConfigured()) {
    throw new AppError('provider_unavailable', 'no object storage is configured');
  }
  const reader = store ?? objectStore();
  for (const file of files) {
    const object = await reader.head(file.key);
    if (!object) {
      throw new AppError('invalid_request', `${file.name} was not uploaded`);
    }
    if (object.size !== file.size) {
      throw new AppError('invalid_request', `${file.name} is not the size it was declared at`);
    }
  }
}

