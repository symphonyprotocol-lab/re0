/**
 * Workspace policy: read the pinned version, mint the next one.
 * architecture.md 10.
 *
 * A Policy Version is immutable, like a Plan Version: PATCH semantics are
 * incremental on the wire, but the server materialises a complete snapshot
 * as a new `policy_version` row plus its `policy_library_entry` rows, in one
 * transaction. Queries pin the newest version at the start of a request
 * (9.2) and read nothing that can change under them.
 */
import { desc, eq, inArray, sql } from 'drizzle-orm';
import { AppError } from '@/contracts/errors';
import type { PolicyPatch, PolicyResponse, WorkspacePolicyView } from '@/contracts/schemas';
import {
  isChannelEntry,
  isDomainEntry,
  normalizePolicyMode,
  OPEN_POLICY,
  OPEN_QUALITY,
  PRIVATE_SOURCE_TYPE,
  type PolicyQuality,
  type WorkspacePolicy,
} from '@/lib/domain/policy';
import { uuidv7 } from '@/lib/domain/id';
import { db, schema, type Database } from '@/lib/infrastructure/postgres/client';
import { ref } from '@/lib/application/administration/column-ref';
import { sharedWithEveryone } from '@/lib/application/channels/visibility';

export interface PinnedPolicy {
  versionId: string | null;
  policy: WorkspacePolicy;
}

/**
 * Each materialised block/except/allow list may hold this many entries. The
 * per-patch cap (contracts) bounds one request; this bounds what the
 * accumulated snapshot re-inserted with every new version can grow to.
 */
const MAX_LIST_ENTRIES = 1_000;

/**
 * The newest policy version, or the open default when none was ever set.
 * `database` lets a caller pin inside its own transaction; ids are uuidv7,
 * so `desc(id)` breaks a same-timestamp tie deterministically.
 */
export async function pinPolicy(
  workspaceId: string,
  database: Pick<Database, 'select'> = db(),
): Promise<PinnedPolicy> {
  const [version] = await database
    .select({
      id: schema.policyVersion.id,
      mode: schema.policyVersion.mode,
      sourceTypes: schema.policyVersion.sourceTypes,
      qualityFilters: schema.policyVersion.qualityFilters,
    })
    .from(schema.policyVersion)
    .where(eq(schema.policyVersion.workspaceId, workspaceId))
    .orderBy(desc(schema.policyVersion.createdAt), desc(schema.policyVersion.id))
    .limit(1);

  if (!version) return { versionId: null, policy: OPEN_POLICY };

  const entries = await database
    .select({
      kind: schema.policyLibraryEntry.kind,
      targetValue: schema.policyLibraryEntry.targetValue,
    })
    .from(schema.policyLibraryEntry)
    .where(eq(schema.policyLibraryEntry.policyVersionId, version.id));

  const list = (kind: string) =>
    entries.filter((entry) => entry.kind === kind).map((entry) => entry.targetValue);
  return {
    versionId: version.id,
    /* Read as what it enforces: a version stored before `mode` was written
       alongside its thresholds is a quality policy (`normalizePolicyMode`). */
    policy: normalizePolicyMode({
      mode: version.mode,
      sourceTypes: version.sourceTypes,
      quality: readQuality(version.qualityFilters as Partial<PolicyQuality>),
      blockedLibraries: list('block'),
      exceptedLibraries: list('except'),
      allowedLibraries: list('allow'),
    }),
  };
}

/**
 * Older versions were stored before a threshold existed; each missing key
 * reads as "not set", which is what those versions meant.
 */
function readQuality(stored: Partial<PolicyQuality>): PolicyQuality {
  return patchQuality(OPEN_QUALITY, stored);
}

/** A key present in the patch is set (null unsets); an absent one is kept. */
function patchQuality(
  current: PolicyQuality,
  patch: Partial<PolicyQuality> | undefined,
): PolicyQuality {
  const next: PolicyQuality = { ...current };
  if (!patch) return next;
  for (const key of Object.keys(OPEN_QUALITY) as (keyof PolicyQuality)[]) {
    const value = patch[key];
    if (value !== undefined) (next as Record<keyof PolicyQuality, unknown>)[key] = value;
  }
  return next;
}

export async function readPolicy(workspaceId: string, requestId: string): Promise<PolicyResponse> {
  const pinned = await pinPolicy(workspaceId);
  return {
    policyVersionId: pinned.versionId,
    policy: toView(pinned.policy),
    accessibleLibraryCount: await countReachableLibraries(workspaceId, pinned.policy),
    requestId,
  };
}

/** Apply an incremental patch and mint the next immutable version. */
export async function patchPolicy(
  workspaceId: string,
  patch: PolicyPatch,
  requestId: string,
): Promise<PolicyResponse> {
  const versionId = uuidv7();
  const next = await db().transaction(async (tx) => {
    /*
     * Read-modify-insert is one critical section per workspace. Without the
     * lock two concurrent patches snapshot the same base and the loser's
     * changes silently vanish from the version that wins. Transaction-scoped,
     * so it is released on commit or rollback either way.
     */
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${workspaceId}))`);

    const current = (await pinPolicy(workspaceId, tx)).policy;

    const patched: WorkspacePolicy = {
      mode: patch.mode === 'clear' ? null : (patch.mode ?? current.mode),
      sourceTypes: { ...current.sourceTypes },
      quality: patchQuality(current.quality, patch.quality),
      blockedLibraries: patchList(current.blockedLibraries, patch.blocked),
      exceptedLibraries: patchList(current.exceptedLibraries, patch.excepted),
      allowedLibraries: patchList(current.allowedLibraries, patch.allowed),
    };
    for (const type of patch.sourceTypes?.enable ?? []) delete patched.sourceTypes[type];
    for (const type of patch.sourceTypes?.disable ?? []) patched.sourceTypes[type] = false;
    /*
     * Stored unambiguous: a patch that sets a threshold or an "always allow"
     * entry without naming a mode still means quality mode, and the version
     * row must say so or the evaluator will ignore what the console showed.
     */
    const next = normalizePolicyMode(patched);

    const overLimit = (
      [
        ['blocked', next.blockedLibraries],
        ['excepted', next.exceptedLibraries],
        ['allowed', next.allowedLibraries],
      ] as const
    ).find(([, list]) => list.length > MAX_LIST_ENTRIES);
    if (overLimit) {
      throw new AppError(
        'invalid_request',
        `the ${overLimit[0]} list cannot exceed ${MAX_LIST_ENTRIES} entries`,
      );
    }

    await tx.insert(schema.policyVersion).values({
      id: versionId,
      workspaceId,
      mode: next.mode,
      sourceTypes: next.sourceTypes,
      qualityFilters: { ...next.quality },
      appliedAt: new Date(),
    });
    const rows = [
      ...next.blockedLibraries.map((value) => ({ kind: 'block', value })),
      ...next.exceptedLibraries.map((value) => ({ kind: 'except', value })),
      ...next.allowedLibraries.map((value) => ({ kind: 'allow', value })),
    ];
    if (rows.length > 0) {
      await tx.insert(schema.policyLibraryEntry).values(
        rows.map((row) => ({
          id: uuidv7(),
          policyVersionId: versionId,
          kind: row.kind,
          targetType: isDomainEntry(row.value) ? 'domain' : isChannelEntry(row.value) ? 'channel' : 'library',
          targetValue: row.value,
        })),
      );
    }
    return next;
  });

  return {
    policyVersionId: versionId,
    policy: toView(next),
    accessibleLibraryCount: await countReachableLibraries(workspaceId, next),
    requestId,
  };
}

function patchList(
  current: string[],
  patch: { add?: string[]; remove?: string[]; clear?: boolean } | undefined,
): string[] {
  if (!patch) return current;
  const next = new Set(patch.clear ? [] : current);
  for (const value of patch.add ?? []) next.add(value);
  for (const value of patch.remove ?? []) next.delete(value);
  return [...next];
}

function toView(policy: WorkspacePolicy): WorkspacePolicyView {
  return policy;
}

/**
 * How many libraries this policy admits for the workspace -- the number the
 * console shows next to a rule change (requirement.md 5.2): everything shared
 * with everyone plus the workspace's own assets (agent-first-proposal.md 6.2).
 *
 * Every rule the evaluator (lib/domain/policy.ts) can decide from stored
 * facts is counted here in SQL: the source switches, the three lists, and
 * the verification, trust and freshness thresholds. The repo and website
 * metrics are not collected yet, so the evaluator passes them as unknown and
 * this count agrees with it.
 */
export async function countReachableLibraries(
  workspaceId: string,
  policy: WorkspacePolicy,
): Promise<number> {
  const privateDisabled = policy.sourceTypes[PRIVATE_SOURCE_TYPE] === false;
  const disabledTypes = Object.keys(policy.sourceTypes).filter(
    (type) => type !== PRIVATE_SOURCE_TYPE && policy.sourceTypes[type] === false,
  );

  const clauses = [
    sql`${schema.library.deletedAt} is null`,
    sql`${schema.library.lifecycleStatus} = 'published'`,
    sql`${schema.library.indexStatus} = 'ready'`,
    sql`${schema.library.currentVersionId} is not null`,
    /* The `private` switch covers the owner's assets that are not in a
       public channel; with it off, only what is shared with everyone. */
    privateDisabled
      ? sharedWithEveryone()
      : sql`(${sharedWithEveryone()} or ${schema.library.ownerWorkspaceId} = ${workspaceId})`,
  ];
  if (disabledTypes.length > 0) {
    clauses.push(sql`not exists (
      select 1 from ${schema.source} s
      where s.library_id = ${ref(schema.library.id)}
        and s.type in (${sql.join(
          disabledTypes.map((type) => sql`${type}`),
          sql`, `,
        )})
    )`);
  }
  if (policy.blockedLibraries.length > 0) {
    clauses.push(sql`not ${listedInSql(policy.blockedLibraries)}`);
  }

  if (policy.mode === 'select') {
    if (policy.allowedLibraries.length === 0) return 0;
    clauses.push(listedInSql(policy.allowedLibraries));
  } else if (policy.mode === 'quality') {
    const thresholds = [];
    if (policy.quality.requireVerified) {
      thresholds.push(
        sql`(${schema.library.isPlatformLibrary} or ${schema.library.ownerWorkspaceId} is not null)`,
      );
    }
    if (policy.quality.minTrustScore !== null) {
      thresholds.push(sql`coalesce((
        select s.trust_score from ${schema.libraryScore} s
        where s.library_id = ${ref(schema.library.id)}
        order by s.computed_at desc limit 1
      ), 0) >= ${policy.quality.minTrustScore}`);
    }
    if (policy.quality.maxAgeDays !== null) {
      thresholds.push(sql`(${schema.library.lastSuccessfulRefreshAt} is null
        or ${schema.library.lastSuccessfulRefreshAt} >= now() - make_interval(days => ${policy.quality.maxAgeDays}))`);
    }
    if (thresholds.length > 0) {
      const all = sql`(${sql.join(thresholds, sql` and `)})`;
      clauses.push(
        policy.exceptedLibraries.length > 0
          ? sql`(${listedInSql(policy.exceptedLibraries)} or ${all})`
          : all,
      );
    }
  }

  const [row] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.library)
    .where(sql.join(clauses, sql` and `));
  return row?.n ?? 0;
}

/**
 * `listedIn` (lib/domain/policy.ts) as a predicate over a library row, for
 * the preview count: exact entries by `public_id` equality, `/prefix/*`
 * entries as the prefix itself or anything nested under it, and domain
 * entries against the host of any of the library's source locations.
 * `like` is given an escaped prefix, so a `_` in a slug matches itself.
 *
 * Ids are folded to lower case on both sides, exactly as
 * `libraryEntryMatches` folds them: a repository Library ID keeps GitHub's
 * casing, so `vercel` must reach `/Vercel/next.js` here too or the count
 * would disagree with the evaluator it previews.
 */
function listedInSql(entries: readonly string[]) {
  const domains = entries.filter(isDomainEntry).map((entry) => entry.toLowerCase());
  const channels = entries.filter(isChannelEntry).map((entry) => entry.toLowerCase());
  const ids = entries
    .filter((entry) => !isDomainEntry(entry) && !isChannelEntry(entry))
    .map((entry) => entry.toLowerCase());
  const exact = ids.filter((entry) => !entry.endsWith('/*'));
  const prefixes = ids.filter((entry) => entry.endsWith('/*')).map((entry) => entry.slice(0, -2));
  const clauses = [
    ...(exact.length > 0 ? [inArray(PUBLIC_ID, exact)] : []),
    ...prefixes.flatMap((prefix) => [
      sql`${PUBLIC_ID} = ${prefix}`,
      sql`${PUBLIC_ID} like ${`${escapeLike(prefix)}/%`}`,
    ]),
    ...channels.map((entry) => {
      const named = entry.endsWith('/*') ? null : entry;
      return sql`exists (
        select 1 from ${schema.channelAsset} ca
        join ${schema.channel} c on c.id = ca.channel_id
        where ca.asset_id = ${ref(schema.library.id)}
          ${named ? sql`and '/channels/' || c.slug = ${named}` : sql``}
      )`;
    }),
    ...domains.map(
      (domain) => sql`exists (
        select 1 from ${schema.source} s
        where s.library_id = ${ref(schema.library.id)}
          and (${SOURCE_HOST} = ${domain} or ${SOURCE_HOST} like ${`%.${escapeLike(domain)}`})
      )`,
    ),
  ];
  return sql`(${sql.join(clauses, sql` or `)})`;
}

/** The library's public id, folded for a case-insensitive entry match. */
const PUBLIC_ID = sql`lower(${schema.library.publicId})`;

/** The lower-cased host of a source location URL, or null for a non-URL. */
const SOURCE_HOST = sql`lower(substring(s.location from '^[a-zA-Z][a-zA-Z0-9+.-]*://([^/:?#]+)'))`;

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}
