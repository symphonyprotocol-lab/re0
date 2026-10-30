/**
 * One build: a set of sources in, one indexed but unpublished Version out.
 *
 * Sources are compared one by one against the current version
 * (`asset_version.source_digests`). A source whose fresh snapshot digests
 * the same as last time is *carried forward*: its documents and chunks --
 * vectors included -- are copied into the new version under new ids, and
 * nothing of it is parsed or embedded again. Only sources that changed go
 * through the pipeline. A refresh that names one source (`workflow_operation
 * .source_id`) does not even fetch the others. The version stays what it
 * always was, one immutable snapshot of the whole asset; what changes is
 * how much of it was recomputed.
 *
 * This is architecture.md 8.2 steps 2 through 9 -- fetch, scan, discover,
 * normalize, cite, chunk, embed-index, profile, evaluate. Step 10 (review) does
 * not apply to a platform asset (architecture.md 8.1 routes it straight to
 * publishing) and step 11 is `publish-version.ts`, deliberately separate: a version that is
 * built but not pointed at is a safe state, and one this module can leave
 * behind if publishing has to wait.
 *
 * The version is written as `processing` and only becomes `ready` once every
 * chunk of it is in the table. requirement.md 8.1 forbids switching
 * `current_version` before a version is completely ready, and the cheapest way
 * to keep that promise is for "ready" to be the last thing written.
 */
import { and, count, eq, inArray, like, or, sql } from 'drizzle-orm';
import {
  CHUNKER_VERSION,
  chunkDocument,
  citationFor,
  documentFormat,
  IngestionFailure,
  INGESTION_LIMITS,
  isFallbackDocument,
  merkleRoot,
  parseDocument,
  PARSER_VERSION,
  safetyFindingsOf,
  safetyStatusOf,
  scanContent,
  SCORE_ALGORITHM_VERSION,
  scoreAsset,
  sha256Hex,
  snapshotDigest,
  summarizeFetch,
  textSearchConfig,
  versionLabel,
  type Citation,
  type ParsedDocument,
  type BuildProgress,
  type IngestionStage,
} from '@/lib/domain/ingestion';
import { uuidv7 } from '@/lib/domain/id';
import { segmentCjkForIndex } from '@/lib/domain/cjk';
import {
  CentroidAccumulator,
  extractTerms,
  PROFILE_LIMITS,
  PROFILE_VERSION,
  profileSearchText,
} from '@/lib/domain/profile';
import {
  isBuildableSourceType,
  withDeclaredParseScope,
  type BuildableSourceType,
} from '@/lib/domain/asset';
import { notionSourceUserId } from '@/lib/domain/notion';
import { notionTokenFor } from '@/lib/application/auth/notion-connection';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { faqCanonical, faqDocument, faqDocumentPath, faqDocumentUrl, isFaqPath } from '@/lib/domain/faq';
import { faqEntriesForBuild } from './faq-entries';
import { objectKeys } from '@/lib/infrastructure/objects/store';
import { contentSketch } from '@/lib/domain/fingerprint';
import { platformTermWeight } from './term-weights';
import type { FetchedFile, SourceSnapshot } from '@/lib/infrastructure/connectors';
import { defaultDependencies, type IngestionDependencies } from './dependencies';
import type { BuildFacts } from '@/lib/domain/build-billing';
import { workspaceStorage } from '@/lib/application/plans/storage';

export interface BuildInput {
  assetId: string;
  operationId: string;
  dependencies?: IngestionDependencies;
  /**
   * Runs once chunking has measured the build and before anything is
   * embedded -- the last point at which stopping costs the platform nothing.
   * asset-build-billing.md 4.3: the worker prices the build here and
   * throws `quota_exceeded` when the workspace cannot cover it.
   */
  beforeIndex?: (facts: BuildFacts) => Promise<void>;
}

export type BuildOutcome =
  | { changed: false; digest: string }
  | {
      changed: true;
      digest: string;
      versionId: string;
      documents: number;
      chunks: number;
      /** What the build added, as the billing formula reads it. */
      facts: BuildFacts;
    };

/** Rows are inserted in batches so one build is not one enormous statement. */
const INSERT_BATCH = 250;

/**
 * Tell the queue row where the build is. Best-effort on purpose: a readout
 * is not worth failing a build over, so a write that fails is logged and
 * forgotten. `progress` fields merge over what the row already holds, so a
 * stage that counts nothing new keeps the counts before it.
 */
async function reportProgress(
  database: ReturnType<typeof db>,
  operationId: string,
  stage: IngestionStage,
  progress?: BuildProgress,
): Promise<void> {
  try {
    await database
      .update(schema.workflowOperation)
      .set({
        stage,
        ...(progress
          ? {
              progress: sql`coalesce(${schema.workflowOperation.progress}, '{}'::jsonb) || ${JSON.stringify(progress)}::jsonb`,
            }
          : {}),
      })
      .where(eq(schema.workflowOperation.id, operationId));
  } catch (error) {
    console.error(
      `build progress not recorded operationId=${operationId}: ${error instanceof Error ? error.message : 'unknown'}`,
    );
  }
}

/**
 * Independent object-store writes run this many at a time. Serial PUTs make a
 * large asset's build latency-bound (thousands of round trips, one by one);
 * unbounded fan-out makes it a burst the store throttles. Eight is neither.
 */
const PUT_CONCURRENCY = 8;

/**
 * How many chunks are embedded and written before their vectors are released.
 *
 * Large enough that the provider still sees full batches (the adapter splits
 * this into its own requests), small enough that peak memory is a few megabytes
 * whatever the size of the asset.
 */
const EMBED_WINDOW = 500;

export async function buildVersion(input: BuildInput): Promise<BuildOutcome> {
  const dependencies = input.dependencies ?? defaultDependencies;
  const database = db();

  /* ------------------------------------------------------ validate-source */

  const available = await dependencies.configured();
  if (!available.embeddings) {
    throw new IngestionFailure(
      'embedding_unavailable',
      'validate-source',
      'no embedding provider is configured',
    );
  }
  if (!available.storage) {
    throw new IngestionFailure(
      'storage_unavailable',
      'validate-source',
      'no object storage is configured',
    );
  }

  const [asset] = await database
    .select({
      id: schema.asset.id,
      publicId: schema.asset.publicId,
      title: schema.asset.title,
      isPlatformAsset: schema.asset.isPlatformAsset,
      ownerWorkspaceId: schema.asset.ownerWorkspaceId,
      lifecycleStatus: schema.asset.lifecycleStatus,
      currentVersionId: schema.asset.currentVersionId,
      language: schema.asset.language,
      deletedAt: schema.asset.deletedAt,
    })
    .from(schema.asset)
    .where(eq(schema.asset.id, input.assetId))
    .limit(1);

  if (!asset) {
    throw new IngestionFailure('source_unsupported', 'validate-source', 'no such asset');
  }
  /* A tombstone is archived too; named first so the failure says why. */
  if (asset.deletedAt) {
    throw new IngestionFailure('source_unsupported', 'validate-source', 'the asset is deleted');
  }
  if (asset.lifecycleStatus === 'archived') {
    throw new IngestionFailure('source_unsupported', 'validate-source', 'the asset is archived');
  }

  const sources = await database
    .select({
      id: schema.source.id,
      type: schema.source.type,
      location: schema.source.location,
      config: schema.source.config,
    })
    .from(schema.source)
    .where(eq(schema.source.assetId, asset.id))
    .orderBy(schema.source.id);

  if (sources.length === 0) {
    throw new IngestionFailure('source_unsupported', 'validate-source', 'the asset has no source');
  }
  for (const source of sources) {
    if (!isBuildableSourceType(source.type)) {
      throw new IngestionFailure(
        'source_unsupported',
        'validate-source',
        `${source.type} has no connector`,
      );
    }
  }

  /* A refresh that names one source; a name that is not this asset's is
     ignored rather than refused, and the whole asset is refreshed. */
  const [operation] = await database
    .select({ sourceId: schema.workflowOperation.sourceId })
    .from(schema.workflowOperation)
    .where(eq(schema.workflowOperation.id, input.operationId))
    .limit(1);
  const targetSourceId =
    operation?.sourceId && sources.some((source) => source.id === operation.sourceId)
      ? operation.sourceId
      : null;

  /*
   * Which stemmer the keyword index uses, decided once and stamped on every
   * chunk. `asset.language` is free text an operator typed, so the mapping
   * is deliberately forgiving and falls back to `simple` rather than guessing.
   */
  const searchConfig = textSearchConfig(asset.language);
  const adapter = await dependencies.embeddings();

  const current = asset.currentVersionId
    ? await database
        .select({
          id: schema.assetVersion.id,
          digest: schema.assetVersion.sourceDigest,
          sourceDigests: schema.assetVersion.sourceDigests,
          parserVersion: schema.assetVersion.parserVersion,
          chunkerVersion: schema.assetVersion.chunkerVersion,
          embeddingModel: schema.assetVersion.embeddingModel,
          embeddingDimensions: schema.assetVersion.embeddingDimensions,
          searchConfig: schema.assetVersion.searchConfig,
          faqDigest: schema.assetVersion.faqDigest,
        })
        .from(schema.assetVersion)
        .where(eq(schema.assetVersion.id, asset.currentVersionId))
        .limit(1)
    : [];

  /*
   * The source is only half of what decides whether a rebuild is needed.
   *
   * requirement.md 8.1 freezes the parser, chunker, embedding model and search
   * configuration on a Version, which is a statement that those decide what
   * the version *is* -- the model's width along with its name, since the same
   * model asked for a different number of dimensions produces vectors in a
   * different space. So an unchanged source is a reason to carry it
   * forward only when today's build would produce the same thing: correcting
   * an asset's language or shipping a new chunker must rebuild everything,
   * and without this check both would be reported as "unchanged" and quietly
   * do nothing.
   */
  const built = current[0];
  const sameConfiguration =
    built !== undefined &&
    built.parserVersion === PARSER_VERSION &&
    built.chunkerVersion === CHUNKER_VERSION &&
    built.embeddingModel === adapter.model &&
    built.embeddingDimensions === adapter.dimensions &&
    built.searchConfig === searchConfig;
  const cached = (sameConfiguration && built?.sourceDigests) || {};
  /*
   * A rebuild forced by our own parser, chunker or model moving is the
   * platform's decision, not the owner's (asset-build-billing.md 1.1): the
   * price formula reads this flag and charges nothing. A changed search
   * configuration is the owner's own edit and is not covered.
   */
  const platformRebuild =
    built !== undefined &&
    (built.parserVersion !== PARSER_VERSION ||
      built.chunkerVersion !== CHUNKER_VERSION ||
      built.embeddingModel !== adapter.model ||
      built.embeddingDimensions !== adapter.dimensions ||
      /* A version from before per-source digests carries nothing forward
         (`cached` is empty), so its first refresh re-embeds the whole
         asset. That is our migration, not the owner's change. */
      built.sourceDigests === null);

  /* ------------------------------------------------------- fetch-snapshot */

  await reportProgress(database, input.operationId, 'fetch-snapshot');

  /*
   * Paths are namespaced by source only when there is more than one. A single
   * source is the overwhelmingly common case, and prefixing its paths would
   * put a synthetic directory into every citation for no reason.
   */
  const prefix = (index: number, sourceId: string) =>
    sources.length > 1 ? `${index}-${short(sourceId)}/` : '';

  type SourcePlan = {
    source: (typeof sources)[number];
    record: SourceRecord;
    /** Fetched this build; absent when the source is carried forward unfetched. */
    snapshot?: SourceSnapshot;
    files: SourceFile[];
    /** True when the source's documents come from the current version. */
    carried: boolean;
  };
  const plans: SourcePlan[] = [];
  for (const [index, source] of sources.entries()) {
    const previous = cached[source.id];
    if (targetSourceId && source.id !== targetSourceId && previous) {
      plans.push({ source, record: previous, files: [], carried: true });
      continue;
    }
    const snapshot = await dependencies.fetchSnapshot({
      /* Every type was checked against the connectors above. */
      type: source.type as BuildableSourceType,
      location: source.location,
      config: source.config,
      credential: await sourceCredential(source.type, source.config),
    });
    /*
     * What `re0.json` scoped this fetch to is stamped onto the source row, in
     * the file's own field names, so the asset page can show the scope the
     * index obeyed (requirement.md 5.1) without re-reading the repository.
     *
     * `withDeclaredParseScope` decides whether that stamp may land: the
     * owner's dashboard scope writes the same keys and outranks the file, and
     * a source with no `re0.json` declares nothing, so stamping it
     * unconditionally erased a saved scope on the next build. Null means
     * leave the row alone.
     */
    const declared = withDeclaredParseScope(source.config, {
      folders: snapshot.config.folders,
      excludeFolders: snapshot.config.excludeFolders,
    });
    if (declared) {
      await database
        .update(schema.source)
        .set({ config: declared })
        .where(eq(schema.source.id, source.id));
    }
    const files: SourceFile[] = snapshot.files.map((file) => ({
      ...file,
      path: `${prefix(index, source.id)}${file.path}`,
      sourceId: source.id,
    }));
    const record: SourceRecord = {
      digest: await snapshotDigest(files),
      bytes: files.reduce((total, file) => total + encoder.encode(file.content).length, 0),
      lastModifiedAt: snapshot.lastModifiedAt?.toISOString() ?? null,
      hasLicense: snapshot.hasLicense,
    };
    const carried = previous !== undefined && previous.digest === record.digest;
    plans.push({ source, record, snapshot, files: carried ? [] : files, carried });
  }

  const fetched = plans.filter((plan) => plan.snapshot !== undefined);
  const fetchedFiles = fetched.flatMap((plan) => plan.snapshot!.files);
  /* Pages a connector pulled from a host. A repository, a Notion space or an
     upload reports no fetch method, so those sources count no pages. */
  const pagesFetched = fetchedFiles.filter((file) => file.fetchedVia !== undefined).length;
  if (fetched.length > 0 && fetchedFiles.length === 0) {
    throw new IngestionFailure('source_empty', 'fetch-snapshot', 'the source served no documents');
  }

  /*
   * Recorded as soon as the fetch is known, before the digest decides whether
   * anything else happens: an unchanged source still tells the operator how
   * it was read, and a build that fails later still says which pages needed a
   * renderer.
   */
  await database
    .update(schema.workflowOperation)
    .set({ fetchSummary: summarizeFetch(fetchedFiles) })
    .where(eq(schema.workflowOperation.id, input.operationId));
  await reportProgress(database, input.operationId, 'scan', { files: fetchedFiles.length });

  /*
   * One source: its own digest, as it always was. Several: a digest over
   * their digests, so a version's identity is the identity of its parts and
   * a carried-forward source needs no re-hashing of content this build never
   * saw.
   */
  const digest =
    plans.length === 1
      ? plans[0]!.record.digest
      : await sha256Hex(plans.map((plan) => `${plan.source.id}=${plan.record.digest}`).join('\n'));

  /*
   * architecture.md 8.4: an unchanged digest updates `last_checked_at` and
   * stops. Not creating an empty version is the point -- an asset that is
   * checked hourly and changes yearly would otherwise accumulate thousands of
   * identical versions, each one anchored and each one a superseded row.
   */
  /*
   * The owner's FAQ (lib/domain/faq.ts) is content of the build too: each
   * entry a document, cited to the page it stands for under a URL that marks
   * it as a FAQ. It has no source of its own, so it is never carried forward
   * -- a few entries re-parsed are cheaper than another plan kind -- and the
   * version remembers which FAQ it was built with, so an edit to an entry
   * alone is a change worth a build.
   */
  const faqEntries = await faqEntriesForBuild(asset.id);
  const faqDigest = faqEntries.length > 0 ? await sha256Hex(faqCanonical(faqEntries)) : null;
  const faqUnchanged = (current[0]?.faqDigest ?? null) === faqDigest;

  if (sameConfiguration && plans.every((plan) => plan.carried) && faqUnchanged) {
    await database
      .update(schema.asset)
      .set({ lastCheckedAt: new Date() })
      .where(eq(schema.asset.id, asset.id));
    return { changed: false, digest };
  }

  /*
   * agent-first-proposal.md 8.1: a workspace holds no more content, across
   * all its live assets, than the owner's storage tier allows. This build
   * is measured the way `storage_bytes` is -- the encoded bytes of every
   * source, carried ones included -- added to what the workspace's *other*
   * assets hold (a rebuild replaces this asset's bytes), and refused
   * here, after the fetch and before anything is parsed, embedded or priced,
   * so an oversized build costs neither side anything. Only a build that
   * would write a version is held to it: an unchanged refresh above returned
   * first, and a workspace already over capacity keeps serving what it has.
   * Platform assets are the operator's and have no tier.
   */
  if (!asset.isPlatformAsset && asset.ownerWorkspaceId) {
    const storage = await workspaceStorage(asset.ownerWorkspaceId, { excludeAssetId: asset.id });
    const total = plans.reduce((sum, plan) => sum + plan.record.bytes, 0);
    if (storage.usedBytes + total > storage.capacityBytes) {
      throw new IngestionFailure(
        'asset_too_large',
        'fetch-snapshot',
        `the content is ${total} bytes, and the workspace has ${storage.remainingBytes} of ${storage.capacityBytes} left`,
      );
    }
  }

  const faqFiles: SourceFile[] = faqEntries.map((entry) => ({
    path: faqDocumentPath(entry),
    url: faqDocumentUrl(entry),
    content: faqDocument(entry),
    sourceId: null,
  }));
  /* FAQ files first: the document cap below cuts the tail, and the owner's
     few answers must not be what a three-thousand-page site drops. */
  const files: SourceFile[] = [...faqFiles, ...plans.flatMap((plan) => plan.files)];
  const carriedPlans = plans.filter((plan) => plan.carried);

  const store = dependencies.store();
  await store.put(
    objectKeys.snapshot(asset.id, input.operationId, 'json'),
    encode({
      digest,
      files: files.map((file) => ({ path: file.path, url: file.url })),
      carried: carriedPlans.map((plan) => ({ sourceId: plan.source.id, digest: plan.record.digest })),
    }),
    'application/json',
  );

  /* ---------------------------------------------------------------- scan */

  const safe: SourceFile[] = [];
  const quarantined: SourceFile[] = [];
  let flaggedFiles = 0;
  const flaggedPaths = new Set<string>();
  /* Which rules fired on a flagged file: kept on its document row for the reviewer. */
  const findingsByPath = new Map<string, string[]>();
  for (const file of files) {
    const findings = scanContent(file.content);
    const status = safetyStatusOf(findings);
    if (status === 'quarantined') {
      quarantined.push(file);
      continue;
    }
    if (status === 'flagged') {
      flaggedFiles += 1;
      flaggedPaths.add(file.path);
      findingsByPath.set(file.path, safetyFindingsOf(findings));
    }
    safe.push(file);
  }

  /*
   * Kept, but out of reach: architecture.md 7 gives quarantine its own
   * prefix that the application cannot read. Deleting the evidence would
   * leave nothing to review when someone asks why a file is missing.
   * The writes are independent of one another, so they run a bounded
   * batch at a time.
   */
  for (let at = 0; at < quarantined.length; at += PUT_CONCURRENCY) {
    await Promise.all(
      quarantined.slice(at, at + PUT_CONCURRENCY).map(async (file) =>
        store.put(
          objectKeys.quarantine(input.operationId, await sha256Hex(file.path)),
          encode({ path: file.path, url: file.url, content: file.content }),
          'application/json',
        ),
      ),
    );
  }

  if (files.length > 0 && safe.length === 0) {
    throw new IngestionFailure('unsafe_content', 'scan', 'every document was quarantined');
  }

  /* ---------------------------------- discover-parse, normalize-cite, chunk */

  const parsed: { file: SourceFile; document: ParsedDocument }[] = [];
  for (const file of safe.slice(0, INGESTION_LIMITS.maxDocuments)) {
    const format =
      file.format ??
      documentFormat(file.path) ??
      (isFallbackDocument(file.path) ? 'text' : null);
    if (!format) continue;
    const document = parseDocument({
      path: file.path,
      format,
      content: file.content,
      /* What the page says it is called, when the connector learned it
         apart from the body (a rendered page), shorn of the site's name. */
      pageTitle: file.title ?? null,
      siteTitle: asset.title,
      /* A file the connector already extracted (an uploaded PDF) is a
         document in its own right and falls back to its own name; a fetched
         page with no heading is the asset's and falls back to its title. */
      fallbackTitle: file.format ? undefined : asset.title,
    });
    if (document.body.trim().length === 0) continue;
    parsed.push({ file, document });
  }

  if (files.length > 0 && parsed.length === 0) {
    throw new IngestionFailure('parse_failed', 'discover-parse', 'nothing parsed to text');
  }
  await reportProgress(database, input.operationId, 'chunk', { documents: parsed.length });

  const versionId = uuidv7();
  const rows: {
    document: {
      id: string;
      title: string;
      sourceUrl: string;
      objectKey: string;
      sourceId: string | null;
      safetyFindings: string[];
    };
    chunks: {
      id: string;
      ordinal: number;
      body: string;
      tokens: number;
      citation: Citation;
      /** Set when the chunk is carried forward: where its vector already is. */
      copiedFrom?: string;
      bodySegmented?: string | null;
    }[];
    /** True when the safety scan flagged the file this document came from. */
    flagged: boolean;
  }[] = [];

  let totalChunks = 0;
  let totalTokens = 0;
  let carriedTokens = 0;
  let citedChunks = 0;
  let flaggedChunks = 0;
  const seenBodies = new Set<string>();
  let duplicates = 0;

  /*
   * Carried-forward sources first, in source order: their documents and
   * chunks are read from the current version and re-keyed for this one. The
   * normalized object in storage is shared -- it is immutable, and the purge
   * that removes an asset removes every key its documents name. The bodies
   * are read because the profile, the Merkle root and the scoring counts need
   * them; the vectors are not, they are copied row by row below.
   */
  for (const plan of carriedPlans) {
    const documents = await database
      .select({
        id: schema.document.id,
        title: schema.document.title,
        sourceUrl: schema.document.sourceUrl,
        objectKey: schema.document.objectKey,
        safetyFindings: schema.document.safetyFindings,
      })
      .from(schema.document)
      .where(and(eq(schema.document.versionId, built!.id), eq(schema.document.sourceId, plan.source.id)))
      .orderBy(schema.document.id);

    for (let at = 0; at < documents.length; at += CARRY_BATCH) {
      const batch = documents.slice(at, at + CARRY_BATCH);
      const chunks = await database
        .select({
          id: schema.chunk.id,
          documentId: schema.chunk.documentId,
          ordinal: schema.chunk.ordinal,
          body: schema.chunk.body,
          tokens: schema.chunk.tokens,
          citation: schema.chunk.citation,
          safetyStatus: schema.chunk.safetyStatus,
          bodySegmented: schema.chunk.bodySegmented,
        })
        .from(schema.chunk)
        .where(
          inArray(
            schema.chunk.documentId,
            batch.map((document) => document.id),
          ),
        )
        .orderBy(schema.chunk.documentId, schema.chunk.ordinal);
      const byDocument = new Map<string, typeof chunks>();
      for (const chunk of chunks) {
        const list = byDocument.get(chunk.documentId) ?? [];
        list.push(chunk);
        byDocument.set(chunk.documentId, list);
      }
      for (const document of batch) {
        const own = byDocument.get(document.id) ?? [];
        if (own.length === 0 || totalChunks >= INGESTION_LIMITS.maxChunks) continue;
        const documentId = uuidv7();
        let flagged = false;
        const copied = own.map((chunk) => {
          const citation = chunk.citation as Citation;
          if (citation.section) citedChunks += 1;
          totalTokens += chunk.tokens;
          carriedTokens += chunk.tokens;
          const key = `${chunk.body.length}:${chunk.body.slice(0, 200)}`;
          if (seenBodies.has(key)) duplicates += 1;
          else seenBodies.add(key);
          if (chunk.safetyStatus === 'flagged') flagged = true;
          return {
            id: uuidv7(),
            ordinal: chunk.ordinal,
            body: chunk.body,
            tokens: chunk.tokens,
            citation,
            copiedFrom: chunk.id,
            bodySegmented: chunk.bodySegmented,
          };
        });
        totalChunks += copied.length;
        if (flagged) flaggedChunks += copied.length;
        rows.push({
          document: {
            id: documentId,
            title: document.title,
            sourceUrl: document.sourceUrl,
            objectKey: document.objectKey ?? objectKeys.normalized(asset.id, versionId, documentId),
            sourceId: plan.source.id,
            safetyFindings: document.safetyFindings,
          },
          chunks: copied,
          flagged,
        });
      }
    }
  }

  for (const { file, document } of parsed) {
    if (totalChunks >= INGESTION_LIMITS.maxChunks) break;

    const documentId = uuidv7();
    const drafts = chunkDocument(document);
    if (drafts.length === 0) continue;

    const chunks = drafts.map((draft) => {
      const citation = citationFor({ document, sourceUrl: file.url, headings: draft.headings });
      /* A FAQ entry's chunk says so in its citation (lib/domain/faq.ts), for the direct answer to find. */
      if (isFaqPath(file.path)) citation.kind = 'faq';
      if (citation.section) citedChunks += 1;
      totalTokens += draft.tokens;
      const key = `${draft.body.length}:${draft.body.slice(0, 200)}`;
      if (seenBodies.has(key)) duplicates += 1;
      else seenBodies.add(key);
      return {
        id: uuidv7(),
        ordinal: draft.ordinal,
        body: draft.body,
        tokens: draft.tokens,
        citation,
      };
    });

    totalChunks += chunks.length;
    const flagged = flaggedPaths.has(file.path);
    if (flagged) flaggedChunks += chunks.length;
    rows.push({
      document: {
        id: documentId,
        title: document.title,
        sourceUrl: file.url,
        objectKey: objectKeys.normalized(asset.id, versionId, documentId),
        sourceId: file.sourceId,
        safetyFindings: findingsByPath.get(file.path) ?? [],
      },
      chunks,
      flagged,
    });
  }

  if (totalChunks === 0) {
    throw new IngestionFailure('parse_failed', 'chunk', 'nothing chunked');
  }
  /* Carried chunks ride in the same windows (their vectors are copied), so
     the count runs from zero to the total whatever the share of fresh ones. */
  await reportProgress(database, input.operationId, 'embed-index', {
    chunksTotal: totalChunks,
    chunksDone: 0,
  });

  /*
   * Measured, and priced by the caller, before a byte reaches the store or
   * the embedding provider. Nothing of this version exists yet, so a refusal
   * here leaves nothing to discard.
   */
  const facts: BuildFacts = {
    freshTokens: totalTokens - carriedTokens,
    carriedTokens,
    pagesFetched,
    platformRebuild,
  };
  if (input.beforeIndex) await input.beforeIndex(facts);

  /* ---------------------------------------------------------- embed-index */

  const pending = rows.flatMap((row) =>
    row.chunks.map((chunk) => ({
      id: chunk.id,
      assetId: asset.id,
      versionId,
      documentId: row.document.id,
      ordinal: chunk.ordinal,
      body: chunk.body,
      tokens: chunk.tokens,
      citation: chunk.citation as Record<string, unknown>,
      /*
       * The scan's verdict for the file, carried onto its chunks. Retrieval
       * still serves `flagged` rows (only `quarantined`/`unsafe` are excluded
       * from its predicate); the status records what the scan found rather
       * than hiding it behind a blanket `clean`.
       */
      safetyStatus: row.flagged ? 'flagged' : 'clean',
      searchConfig,
      /* Pre-segmented CJK for the keyword index Postgres cannot build itself.
         lib/domain/cjk.ts; null for chunks with no Han text. A carried chunk
         keeps what it had. */
      bodySegmented:
        chunk.copiedFrom !== undefined ? (chunk.bodySegmented ?? null) : segmentCjkForIndex(chunk.body),
      copiedFrom: chunk.copiedFrom,
    })),
  );

  const leaves = await Promise.all(
    rows.flatMap((row) =>
      row.chunks.map((chunk) => sha256Hex(`${row.document.id}:${chunk.ordinal}:${chunk.body}`)),
    ),
  );
  const root = await merkleRoot(leaves);

  /*
   * Objects first, transaction second. architecture.md 8.3: the only ordering
   * that crosses systems is that an object referenced by a committed row must
   * already exist. An object with no row is collected by the store's lifecycle
   * rules; a row pointing at an object that was never written is a broken
   * asset.
   */
  const fresh = rows.filter((row) => row.chunks[0]?.copiedFrom === undefined);
  for (let at = 0; at < fresh.length; at += PUT_CONCURRENCY) {
    await Promise.all(
      fresh.slice(at, at + PUT_CONCURRENCY).map((row) =>
        store.put(
          row.document.objectKey,
          encode({
            title: row.document.title,
            url: row.document.sourceUrl,
            chunks: row.chunks.map((chunk) => ({
              ordinal: chunk.ordinal,
              tokens: chunk.tokens,
              citation: chunk.citation,
              body: chunk.body,
            })),
          }),
          'application/json',
        ),
      ),
    );
  }
  await store.put(
    objectKeys.documentManifest(asset.id, versionId),
    encode(rows.map((row) => ({ id: row.document.id, title: row.document.title, url: row.document.sourceUrl }))),
    'application/json',
  );
  await store.put(
    objectKeys.vectorManifest(asset.id, versionId),
    encode({
      model: adapter.model,
      dimensions: adapter.dimensions,
      searchConfig,
      leaves,
    }),
    'application/json',
  );

  /*
   * requirement.md 4.1 measures an asset's capacity in bytes of content, and a
   * JavaScript string length is UTF-16 code units -- one per Han character
   * where UTF-8 spends three. Counting the encoded form is the difference
   * between a Chinese asset reporting its real size and reporting a third of
   * it. The connectors already count this way.
   */
  const bytes = plans.reduce((total, plan) => total + plan.record.bytes, 0);

  /*
   * The same source can now be built more than once -- a configuration change
   * rebuilds unchanged bytes -- so the label is numbered against what this
   * asset already has.
   *
   * One clock read for both the base and the stored label: two would let a
   * build that crosses midnight count against yesterday's base and write
   * today's, producing a `.2` with no `.1`. The count runs inside the
   * transaction that inserts the row, so two builds racing here cannot both
   * read the same number; `asset_version_label_uq` is the backstop.
   */
  const builtAt = new Date();
  const base = versionLabel(digest, builtAt);

  await database.transaction(async (tx) => {
    const [priorBuilds] = await tx
      .select({ n: count() })
      .from(schema.assetVersion)
      .where(
        and(
          eq(schema.assetVersion.assetId, asset.id),
          or(eq(schema.assetVersion.label, base), like(schema.assetVersion.label, `${base}.%`)),
        ),
      );

    await tx.insert(schema.assetVersion).values({
      id: versionId,
      assetId: asset.id,
      label: versionLabel(digest, builtAt, (priorBuilds?.n ?? 0) + 1),
      sourceDigest: digest,
      sourceDigests: Object.fromEntries(plans.map((plan) => [plan.source.id, plan.record])),
      parserVersion: PARSER_VERSION,
      chunkerVersion: CHUNKER_VERSION,
      embeddingModel: adapter.model,
      embeddingDimensions: adapter.dimensions,
      searchConfig,
      contentMerkleRoot: root,
      faqDigest,
      /* For the review rules' duplicate check (lib/domain/fingerprint.ts). */
      contentSketch: contentSketch(rows.flatMap((row) => row.chunks.map((chunk) => chunk.body))),
      /* Not `ready`: nothing has been embedded yet. */
      indexStatus: 'processing',
      totalTokens,
      totalChunks,
    });

    await tx.insert(schema.document).values(
      rows.map((row) => ({
        id: row.document.id,
        assetId: asset.id,
        versionId,
        title: row.document.title,
        sourceUrl: row.document.sourceUrl,
        objectKey: row.document.objectKey,
        sourceId: row.document.sourceId,
        safetyFindings: row.document.safetyFindings,
      })),
    );
  });

  /*
   * Embedded and inserted a window at a time, and the vectors are dropped as
   * soon as they are written.
   *
   * Holding every vector for a build is what makes a large asset impossible
   * rather than slow: the caps above permit roughly forty thousand chunks, and
   * forty thousand 1536-dimension vectors is about half a gigabyte of live
   * JavaScript numbers before a single row is sent. A window keeps that flat --
   * a few megabytes -- whatever the size of the source.
   *
   * The chunks are therefore not written in one transaction, and they do not
   * need to be. architecture.md 8.3 requires the *publication* to be atomic,
   * and `publish-version.ts` is that transaction: it refuses a version that is
   * not `ready` and counts its chunks against `total_chunks` before moving the
   * pointer. A build interrupted here leaves a `processing` version that can
   * never be published, which `discardVersion` then clears away.
   */
  /*
   * The profile (architecture.md 8.2 step 8, 9.6) is accumulated while the
   * vectors stream past, because they are dropped as soon as they are written:
   * the centroid accumulator keeps k running means, never the vectors. Terms
   * come from the same bodies being embedded; titles from the document rows.
   * All of it derived, all of it rebuilt with the version (architecture.md 6.4).
   */
  const centroids = new CentroidAccumulator();

  try {
    for (let offset = 0; offset < pending.length; offset += EMBED_WINDOW) {
      const window = pending.slice(offset, offset + EMBED_WINDOW);
      const vectors = await vectorsFor(window, adapter, database);
      for (const vector of vectors) centroids.add(vector);

      for (let at = 0; at < window.length; at += INSERT_BATCH) {
        await database.insert(schema.chunk).values(
          window.slice(at, at + INSERT_BATCH).map(({ copiedFrom: _copied, ...chunk }, index) => ({
            ...chunk,
            embedding: vectors[at + index] as number[],
          })),
        );
      }
      /* Once per window, after its rows exist: what the console may count on. */
      await reportProgress(database, input.operationId, 'embed-index', {
        chunksTotal: totalChunks,
        chunksDone: Math.min(totalChunks, offset + window.length),
      });
    }
    await reportProgress(database, input.operationId, 'profile', {
      chunksTotal: totalChunks,
      chunksDone: totalChunks,
    });

    const titles = rows.map((row) => row.document.title).slice(0, PROFILE_LIMITS.maxTitles);
    const terms = extractTerms(
      pending.map((chunk) => chunk.body),
      PROFILE_LIMITS.maxTerms,
      await platformTermWeight(asset.id),
    );

    await database.transaction(async (tx) => {
      /*
       * Counted from the table, not from the loop above, so `ready` is a
       * statement about rows that exist rather than about writes we believe
       * succeeded.
       */
      const [written] = await tx
        .select({ n: count() })
        .from(schema.chunk)
        .where(eq(schema.chunk.versionId, versionId));

      if ((written?.n ?? 0) !== totalChunks) {
        throw new IngestionFailure(
          'index_incomplete',
          'embed-index',
          'the version is missing chunks',
        );
      }

      /*
       * The profile rides in the `ready` transaction, so `ready` implies "this
       * version can be routed to" -- asset discovery never meets a version
       * whose chunks exist but whose profile does not.
       */
      await tx.insert(schema.assetProfile).values({
        id: uuidv7(),
        assetId: asset.id,
        versionId,
        profileVersion: PROFILE_VERSION,
        documentTitles: titles,
        terms,
        searchText: profileSearchText(titles, terms),
      });

      const vectors = centroids.centroids();
      if (vectors.length > 0) {
        await tx.insert(schema.assetProfileVector).values(
          vectors.map((embedding, ordinal) => ({
            id: uuidv7(),
            assetId: asset.id,
            versionId,
            ordinal,
            embedding,
          })),
        );
      }

      /* Last, so `ready` is never true of a version that is missing chunks. */
      await tx
        .update(schema.assetVersion)
        .set({ indexStatus: 'ready' })
        .where(eq(schema.assetVersion.id, versionId));

      await tx
        .update(schema.asset)
        .set({
          lastCheckedAt: new Date(),
          lastSuccessfulRefreshAt: new Date(),
          storageBytes: bytes,
        })
        .where(eq(schema.asset.id, asset.id));
    });
  } catch (error) {
    await discardVersion(database, versionId);
    throw error;
  }

  /* ------------------------------------------------------------- evaluate */

  await reportProgress(database, input.operationId, 'evaluate');

  const newest = plans
    .map((plan) => (plan.record.lastModifiedAt ? new Date(plan.record.lastModifiedAt) : null))
    .filter((value): value is Date => value !== null && !Number.isNaN(value.getTime()))
    .sort((a, b) => b.getTime() - a.getTime())[0];

  const scores = scoreAsset({
    verified: false,
    isPlatformAsset: asset.isPlatformAsset,
    documents: rows.length,
    chunks: totalChunks,
    duplicateRatio: totalChunks === 0 ? 0 : duplicates / totalChunks,
    citedRatio: totalChunks === 0 ? 0 : citedChunks / totalChunks,
    flaggedChunks,
    ageDays: newest ? Math.max(0, (Date.now() - newest.getTime()) / 86_400_000) : 3_650,
    hasLicense: plans.some((plan) => plan.record.hasLicense),
  });

  await database.insert(schema.assetScore).values({
    id: uuidv7(),
    assetId: asset.id,
    algorithmVersion: SCORE_ALGORITHM_VERSION,
    trustScore: scores.trust,
    benchmarkScore: scores.benchmark,
    breakdown: {
      documents: rows.length,
      chunks: totalChunks,
      tokens: totalTokens,
      flaggedFiles,
      quarantinedFiles: files.length - safe.length,
    },
  });

  return { changed: true, digest, versionId, documents: rows.length, chunks: totalChunks, facts };
}

/**
 * Clears away a version that never became `ready`.
 *
 * Best effort, and deliberately so: it runs while another failure is already
 * being reported, and failing to tidy up must not replace the reason the build
 * stopped with a reason about the tidying. What it leaves behind if it fails is
 * a `processing` version, which nothing publishes and nothing queries.
 */
async function discardVersion(database: ReturnType<typeof db>, versionId: string): Promise<void> {
  try {
    await database
      .delete(schema.assetProfileVector)
      .where(eq(schema.assetProfileVector.versionId, versionId));
    await database
      .delete(schema.assetProfile)
      .where(eq(schema.assetProfile.versionId, versionId));
    await database.delete(schema.chunk).where(eq(schema.chunk.versionId, versionId));
    await database.delete(schema.document).where(eq(schema.document.versionId, versionId));
    await database.delete(schema.assetVersion).where(eq(schema.assetVersion.id, versionId));
  } catch (error) {
    console.error(
      `could not discard incomplete version ${versionId}: ${
        error instanceof Error ? error.message : 'unknown'
      }`,
    );
  }
}

/** What a version remembers about one source; `asset_version.source_digests`. */
type SourceRecord = {
  digest: string;
  bytes: number;
  lastModifiedAt: string | null;
  hasLicense: boolean;
};

/** A fetched file that knows which source it came from. */
/** A file of the build: a source's, or the FAQ's (no source). */
type SourceFile = FetchedFile & { sourceId: string | null };

/** Carried-forward documents are read this many at a time. */
const CARRY_BATCH = 50;

const encoder = new TextEncoder();

/**
 * The vectors for one window of chunks: freshly embedded for new chunks,
 * copied from the current version's rows for carried ones. Mixed windows
 * are normal at the boundary between a carried source and a changed one.
 */
async function vectorsFor(
  window: { body: string; copiedFrom?: string }[],
  adapter: { embed(texts: string[]): Promise<number[][]> },
  database: ReturnType<typeof db>,
): Promise<number[][]> {
  const vectors: (number[] | undefined)[] = new Array(window.length);

  const fresh = window.map((chunk, index) => ({ chunk, index })).filter(({ chunk }) => !chunk.copiedFrom);
  if (fresh.length > 0) {
    const embedded = await adapter.embed(fresh.map(({ chunk }) => chunk.body));
    if (embedded.length !== fresh.length) {
      throw new IngestionFailure(
        'embedding_unavailable',
        'embed-index',
        'the embedding provider returned the wrong number of vectors',
      );
    }
    fresh.forEach(({ index }, at) => {
      vectors[index] = embedded[at];
    });
  }

  const copied = window.map((chunk, index) => ({ chunk, index })).filter(({ chunk }) => chunk.copiedFrom);
  if (copied.length > 0) {
    const rows = await database
      .select({ id: schema.chunk.id, embedding: schema.chunk.embedding })
      .from(schema.chunk)
      .where(
        inArray(
          schema.chunk.id,
          copied.map(({ chunk }) => chunk.copiedFrom!),
        ),
      );
    const byId = new Map(rows.map((row) => [row.id, row.embedding]));
    for (const { chunk, index } of copied) {
      const vector = byId.get(chunk.copiedFrom!);
      if (!vector) {
        throw new IngestionFailure('index_incomplete', 'embed-index', 'a carried chunk has no vector');
      }
      vectors[index] = vector;
    }
  }

  return vectors as number[][];
}

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function short(id: string): string {
  return id.replace(/-/g, '').slice(0, 8);
}

/**
 * The credential one source is fetched with, when it has one.
 *
 * A Notion source imported through a person's connection names that person
 * on its config (lib/domain/notion.ts); their grant is the only thing that
 * can read the page, so a grant that is gone -- disconnected, revoked and
 * forgotten -- fails the build as `source_forbidden` rather than falling
 * back to the platform's own token and reading with someone else's
 * credential. A platform asset names nobody and keeps using the
 * environment's token.
 */
async function sourceCredential(
  type: string,
  config: Record<string, unknown> | null | undefined,
): Promise<string | undefined> {
  if (type !== 'notion') return undefined;
  const userId = notionSourceUserId(config);
  if (!userId) return undefined;
  const token = await notionTokenFor(userId);
  if (!token) {
    throw new IngestionFailure(
      'source_forbidden',
      'validate-source',
      'the Notion connection this asset was imported with is gone',
    );
  }
  return token;
}
