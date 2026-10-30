/**
 * The channel profile (agent-first-proposal.md 3.7; architecture.md 9.6).
 *
 * Split into one asset per source, a single asset is often too small to say
 * what a channel is about, so cross-channel discovery happens a level up: the
 * channel's profile is the aggregate of its public assets' profiles -- their
 * terms, document titles and kinds. Only assets shared with everyone count;
 * an unlisted or paid asset's vocabulary must not leak into a public profile
 * (architecture.md 9.6, "Policy 与可见性先于路由").
 *
 * Recomputed whenever membership changes and after a build of a member
 * asset; cheap, since it reads the profiles the build already wrote.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { sharedWithEveryone } from './visibility';

const PROFILE_TERMS = 40;
const PROFILE_TITLES = 20;

export interface ChannelProfile {
  terms: string[];
  documentTitles: string[];
  kinds: string[];
  assetCount: number;
  updatedAt: string;
}

export async function refreshChannelProfile(channelId: string): Promise<ChannelProfile> {
  const database = db();
  const rows = await database
    .select({
      kind: schema.library.kind,
      terms: schema.libraryProfile.terms,
      documentTitles: schema.libraryProfile.documentTitles,
    })
    .from(schema.channelAsset)
    .innerJoin(schema.library, eq(schema.library.id, schema.channelAsset.assetId))
    .leftJoin(schema.libraryProfile, eq(schema.libraryProfile.versionId, schema.library.currentVersionId))
    .where(
      and(
        eq(schema.channelAsset.channelId, channelId),
        eq(schema.library.lifecycleStatus, 'published'),
        sharedWithEveryone(),
      ),
    );

  /* Terms ranked by how many assets carry them, then by first appearance. */
  const termCounts = new Map<string, number>();
  const titles: string[] = [];
  const kinds = new Set<string>();
  for (const row of rows) {
    kinds.add(row.kind);
    for (const term of new Set(row.terms ?? [])) termCounts.set(term, (termCounts.get(term) ?? 0) + 1);
    for (const title of row.documentTitles ?? []) {
      if (titles.length < PROFILE_TITLES && !titles.includes(title)) titles.push(title);
    }
  }
  const profile: ChannelProfile = {
    terms: [...termCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, PROFILE_TERMS)
      .map(([term]) => term),
    documentTitles: titles,
    kinds: [...kinds].sort(),
    assetCount: rows.length,
    updatedAt: new Date().toISOString(),
  };
  await database
    .update(schema.channel)
    .set({ profile: profile as unknown as Record<string, unknown> })
    .where(eq(schema.channel.id, channelId));
  return profile;
}

/** After a build: the profile of whatever channel the asset is in. */
export async function refreshChannelProfileOfAsset(assetId: string): Promise<void> {
  const [membership] = await db()
    .select({ channelId: schema.channelAsset.channelId })
    .from(schema.channelAsset)
    .where(inArray(schema.channelAsset.assetId, [assetId]))
    .limit(1);
  if (membership) await refreshChannelProfile(membership.channelId);
}

/** Reads a stored profile back, tolerating the empty object a new channel starts with. */
export function readChannelProfile(stored: Record<string, unknown> | null | undefined): ChannelProfile {
  const list = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);
  return {
    terms: list(stored?.terms),
    documentTitles: list(stored?.documentTitles),
    kinds: list(stored?.kinds),
    assetCount: typeof stored?.assetCount === 'number' ? stored.assetCount : 0,
    updatedAt: typeof stored?.updatedAt === 'string' ? stored.updatedAt : '',
  };
}
