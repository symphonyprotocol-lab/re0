/**
 * Feeding the policy evaluator. architecture.md 10.2: Library Search, Context
 * Retrieval and the web all consult the same evaluator -- this module only
 * assembles its input facts, in one batch, for however many candidates a
 * request holds.
 */
import { inArray, sql } from 'drizzle-orm';
import {
  evaluatePolicy,
  normalizePolicyMode,
  PRIVATE_SOURCE_TYPE,
  type PolicySubject,
  type PolicyVerdict,
  type WorkspacePolicy,
} from '@/lib/domain/policy';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { channelsOfAssets, isPublicChannel } from '@/lib/application/channels/membership';

/**
 * True when the policy cannot refuse anything: skip the fact-gathering.
 * Read through `normalizePolicyMode`, so a policy carrying thresholds is
 * never mistaken for an open one merely because its `mode` was never set.
 */
export function policyIsOpen(policy: WorkspacePolicy): boolean {
  return (
    normalizePolicyMode(policy).mode === null &&
    policy.blockedLibraries.length === 0 &&
    Object.values(policy.sourceTypes).every((enabled) => enabled !== false)
  );
}

export async function policyVerdicts(
  policy: WorkspacePolicy,
  libraryIds: string[],
): Promise<Map<string, PolicyVerdict>> {
  const verdicts = new Map<string, PolicyVerdict>();
  if (libraryIds.length === 0) return verdicts;

  const database = db();
  const libraries = await database
    .select({
      id: schema.library.id,
      publicId: schema.library.publicId,
      ownerWorkspaceId: schema.library.ownerWorkspaceId,
      isPlatformLibrary: schema.library.isPlatformLibrary,
      access: schema.library.access,
      lastSuccessfulRefreshAt: schema.library.lastSuccessfulRefreshAt,
    })
    .from(schema.library)
    .where(inArray(schema.library.id, libraryIds));

  const channels = await channelsOfAssets(libraryIds, database);

  const sources = await database
    .select({
      libraryId: schema.source.libraryId,
      type: schema.source.type,
      location: schema.source.location,
    })
    .from(schema.source)
    .where(inArray(schema.source.libraryId, libraryIds));
  const sourceTypes = new Map<string, string[]>();
  const sourceHosts = new Map<string, string[]>();
  for (const row of sources) {
    const list = sourceTypes.get(row.libraryId) ?? [];
    list.push(row.type);
    sourceTypes.set(row.libraryId, list);
    const host = hostOf(row.location);
    if (host) {
      const hosts = sourceHosts.get(row.libraryId) ?? [];
      hosts.push(host);
      sourceHosts.set(row.libraryId, hosts);
    }
  }

  const scores = await database
    .select({
      libraryId: schema.libraryScore.libraryId,
      trustScore: schema.libraryScore.trustScore,
    })
    .from(schema.libraryScore)
    .where(inArray(schema.libraryScore.libraryId, libraryIds))
    .orderBy(sql`${schema.libraryScore.computedAt} desc`);
  const newestScore = new Map<string, number>();
  for (const row of scores) {
    if (!newestScore.has(row.libraryId)) newestScore.set(row.libraryId, row.trustScore);
  }

  for (const library of libraries) {
    const channel = channels.get(library.id) ?? null;
    const subject: PolicySubject = {
      publicId: library.publicId,
      channel: channel ? `/channels/${channel.slug}` : null,
      /* An asset not shared with everyone -- in no channel, a private one,
         or paid -- answers to the `private` switch as well (10.2), the same
         line the preview count draws (policy-store.ts). */
      sourceTypes: [
        ...(sourceTypes.get(library.id) ?? []),
        ...(isPublicChannel(channel) && library.access === 'free' ? [] : [PRIVATE_SOURCE_TYPE]),
      ],
      domains: sourceHosts.get(library.id) ?? [],
      trustScore: newestScore.get(library.id) ?? 0,
      /* Platform libraries are curated; user libraries are verified by claim. */
      verified: library.isPlatformLibrary || library.ownerWorkspaceId !== null,
      ageDays: library.lastSuccessfulRefreshAt
        ? Math.max(0, (Date.now() - library.lastSuccessfulRefreshAt.getTime()) / 86_400_000)
        : null,
    };
    verdicts.set(library.id, evaluatePolicy(policy, subject));
  }
  return verdicts;
}

/** The host a URL-shaped source location points at; null for uploads and the like. */
function hostOf(location: string): string | null {
  try {
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(location) ? new URL(location).hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** The single-library form Context Retrieval uses. */
export async function policyVerdictFor(
  policy: WorkspacePolicy,
  libraryId: string,
): Promise<PolicyVerdict> {
  const verdicts = await policyVerdicts(policy, [libraryId]);
  return verdicts.get(libraryId) ?? { allowed: true, reason: 'allowed' };
}
