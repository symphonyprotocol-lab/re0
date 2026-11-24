/**
 * One-off: moves the official account's Rees into the travel and literature
 * categories added in migration 0081. Run only by an administrator, by hand
 * (`scripts/recategorise-official-rees.mts`); nothing in the app calls it.
 *
 * - travel: the Wikivoyage guides, still in `life` -- named "… Travel Guide
 *   Assistant" or citing Wikivoyage in their description (a few are named
 *   "… Travel Assistant").
 * - literature: classics still in `other` whose tags or description name a
 *   literary form or genre (novel, poetry, drama, …). Philosophy, history and
 *   other non-fiction classics stay in `other`.
 *
 * Only a Ree still in its old category moves, so a second run, or a Ree its
 * owner has since moved by hand, is left alone.
 */
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { ReeCategory } from '@/lib/constants';
import { db, schema } from '@/lib/infra/db';

export const DEFAULT_OFFICIAL_OWNERS = ['RE0 Official'] as const;

/** Tags (matched whole, case-insensitively) that make a classic literature. */
export const LITERATURE_TAGS = [
  'novel', 'novels', 'novella', 'fiction', 'science fiction', 'historical fiction', 'spy fiction', 'short stories', 'stories',
  'poetry', 'poems', 'poem', 'verse', 'epic', 'sonnets', 'drama', 'play', 'plays', 'comedy', 'tragedy', 'shakespeare',
  'mystery', 'detective', 'adventure', 'fantasy', 'horror', 'romance', 'thriller', 'fairy tales', 'western', 'satire',
  'gothic', 'children', 'humor',
] as const;

/** Words in a description that make a classic literature; "play" and "stories" are left to tags, as descriptions use them loosely. */
const LITERATURE_DESCRIPTION = String.raw`\m(novels?|novella|poems?|poetry|verse|sonnets|drama|tragedy|comedy|fiction)\M`;

export interface RecategoriseRow {
  id: string;
  slug: string;
  name: string;
  owner: string;
}

export interface RecategorisePlan {
  owners: { id: string; name: string }[];
  travel: RecategoriseRow[];
  literature: RecategoriseRow[];
  /** Still in `other` afterwards, for a reader to check nothing was missed. */
  remainingOther: RecategoriseRow[];
}

export interface RecategoriseOptions {
  owners?: readonly string[];
  /** Slugs moved to literature although nothing in their tags or description says so. */
  include?: readonly string[];
  /** Slugs left where they are whatever matches. */
  exclude?: readonly string[];
}

function travelGuide(): SQL {
  return sql`(${schema.ree.name} like '% Travel Guide Assistant' or ${schema.ree.description} ilike '%wikivoyage%')`;
}

function literary(include: readonly string[]): SQL {
  const tags = sql`exists (select 1 from unnest(${schema.ree.tags}) as tag where lower(tag) in (${sql.join(LITERATURE_TAGS.map((tag) => sql`${tag}`), sql`, `)}) or lower(tag) like '% literature')`;
  const forced = include.length ? sql` or ${schema.ree.slug} in (${sql.join(include.map((slug) => sql`${slug}`), sql`, `)})` : sql``;
  return sql`(${tags} or ${schema.ree.description} ~* ${LITERATURE_DESCRIPTION}${forced})`;
}

async function rows(ownerIds: string[], category: ReeCategory, where: SQL | undefined, exclude: readonly string[]): Promise<RecategoriseRow[]> {
  if (!ownerIds.length) return [];
  return db()
    .select({ id: schema.ree.id, slug: schema.ree.slug, name: schema.ree.name, owner: schema.user.name })
    .from(schema.ree)
    .innerJoin(schema.user, eq(schema.user.id, schema.ree.ownerId))
    .where(
      and(
        inArray(schema.ree.ownerId, ownerIds),
        eq(schema.ree.category, category),
        sql`${schema.ree.deletedAt} is null`,
        where,
        exclude.length ? sql`${schema.ree.slug} not in (${sql.join(exclude.map((slug) => sql`${slug}`), sql`, `)})` : undefined,
      ),
    )
    .orderBy(schema.ree.name);
}

export async function planRecategorise(options: RecategoriseOptions = {}): Promise<RecategorisePlan> {
  const names = options.owners?.length ? options.owners : DEFAULT_OFFICIAL_OWNERS;
  const owners = await db()
    .select({ id: schema.user.id, name: schema.user.name })
    .from(schema.user)
    .where(inArray(schema.user.name, [...names]));
  const ids = owners.map((owner) => owner.id);
  const exclude = options.exclude ?? [];
  const travel = await rows(ids, 'life', travelGuide(), exclude);
  const literature = await rows(ids, 'other', literary(options.include ?? []), exclude);
  const moved = new Set(literature.map((row) => row.id));
  const remainingOther = (await rows(ids, 'other', undefined, [])).filter((row) => !moved.has(row.id));
  return { owners, travel, literature, remainingOther };
}

/** Moves the planned Rees, each only if still in the category it was planned from. */
export async function applyRecategorise(plan: RecategorisePlan): Promise<{ travel: number; literature: number }> {
  return db().transaction(async (tx) => {
    const move = async (list: RecategoriseRow[], from: ReeCategory, to: ReeCategory) => {
      if (!list.length) return 0;
      const updated = await tx
        .update(schema.ree)
        .set({ category: to })
        .where(and(inArray(schema.ree.id, list.map((row) => row.id)), eq(schema.ree.category, from)))
        .returning({ id: schema.ree.id });
      return updated.length;
    };
    return { travel: await move(plan.travel, 'life', 'travel'), literature: await move(plan.literature, 'other', 'literature') };
  });
}
