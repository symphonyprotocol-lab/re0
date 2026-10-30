/**
 * Feeding the policy evaluator. architecture.md 10.2: Asset Search, Context
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
    policy.blockedAssets.length === 0 &&
    Object.values(policy.sourceTypes).every((enabled) => enabled !== false)
  );
}

export async function policyVerdicts(
  policy: WorkspacePolicy,
  assetIds: string[],
): Promise<Map<string, PolicyVerdict>> {
  const verdicts = new Map<string, PolicyVerdict>();
  if (assetIds.length === 0) return verdicts;

  const database = db();
  const assets = await database
    .select({
      id: schema.asset.id,
      publicId: schema.asset.publicId,
      ownerWorkspaceId: schema.asset.ownerWorkspaceId,
      isPlatformAsset: schema.asset.isPlatformAsset,
      access: schema.asset.access,
      lastSuccessfulRefreshAt: schema.asset.lastSuccessfulRefreshAt,
    })
    .from(schema.asset)
    .where(inArray(schema.asset.id, assetIds));

  const channels = await channelsOfAssets(assetIds, database);

  const sources = await database
    .select({
      assetId: schema.source.assetId,
      type: schema.source.type,
      location: schema.source.location,
    })
    .from(schema.source)
    .where(inArray(schema.source.assetId, assetIds));
  const sourceTypes = new Map<string, string[]>();
  const sourceHosts = new Map<string, string[]>();
  for (const row of sources) {
    const list = sourceTypes.get(row.assetId) ?? [];
    list.push(row.type);
    sourceTypes.set(row.assetId, list);
    const host = hostOf(row.location);
    if (host) {
      const hosts = sourceHosts.get(row.assetId) ?? [];
      hosts.push(host);
      sourceHosts.set(row.assetId, hosts);
    }
  }

  const scores = await database
    .select({
      assetId: schema.assetScore.assetId,
      trustScore: schema.assetScore.trustScore,
    })
    .from(schema.assetScore)
    .where(inArray(schema.assetScore.assetId, assetIds))
    .orderBy(sql`${schema.assetScore.computedAt} desc`);
  const newestScore = new Map<string, number>();
  for (const row of scores) {
    if (!newestScore.has(row.assetId)) newestScore.set(row.assetId, row.trustScore);
  }

  for (const asset of assets) {
    const channel = channels.get(asset.id) ?? null;
    const subject: PolicySubject = {
      publicId: asset.publicId,
      channel: channel ? `/channels/${channel.slug}` : null,
      /* An asset not shared with everyone -- in no channel, a private one,
         or paid -- answers to the `private` switch as well (10.2), the same
         line the preview count draws (policy-store.ts). */
      sourceTypes: [
        ...(sourceTypes.get(asset.id) ?? []),
        ...(isPublicChannel(channel) && asset.access === 'free' ? [] : [PRIVATE_SOURCE_TYPE]),
      ],
      domains: sourceHosts.get(asset.id) ?? [],
      trustScore: newestScore.get(asset.id) ?? 0,
      /* Platform assets are curated; user assets are verified by claim. */
      verified: asset.isPlatformAsset || asset.ownerWorkspaceId !== null,
      ageDays: asset.lastSuccessfulRefreshAt
        ? Math.max(0, (Date.now() - asset.lastSuccessfulRefreshAt.getTime()) / 86_400_000)
        : null,
    };
    verdicts.set(asset.id, evaluatePolicy(policy, subject));
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

/** The single-asset form Context Retrieval uses. */
export async function policyVerdictFor(
  policy: WorkspacePolicy,
  assetId: string,
): Promise<PolicyVerdict> {
  const verdicts = await policyVerdicts(policy, [assetId]);
  return verdicts.get(assetId) ?? { allowed: true, reason: 'allowed' };
}
