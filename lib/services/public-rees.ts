/**
 * The public page `/r/[slug]` (rebuild-proposal.md 2.4, 8.2 "公开页提问"):
 * what it shows of a public Ree -- never the knowledge itself, only the
 * number of ready sources -- and its two lists, related Rees (from public
 * names, introductions, tags and category only) and the owner's other
 * public Rees.
 */
import { and, desc, eq, ne, or, sql } from 'drizzle-orm';
import { PUBLIC_LIST_PAGE_SIZE, PUBLIC_RELATED_CANDIDATES, QUERY_BASE_FEE } from '@/lib/constants';
import { positiveRate, relatedRees } from '@/lib/domain/explore';
import { db, schema } from '@/lib/infra/db';
import { answersByOthers, publicRee, readySources, reeCards, type ReeCard } from '@/lib/services/explore';

export interface PublicRee {
  id: string;
  slug: string;
  name: string;
  description: string;
  avatarBlob: string | null;
  color: string;
  category: string;
  tags: string[];
  sampleQuestions: string[];
  ownerId: string;
  ownerName: string;
  ownerAvatar: string | null;
  role: 'normal' | 'verified' | 'official';
  queryFee: number;
  price: number;
  sources: number;
  answers: number;
  positiveRate: number | null;
  updatedAt: Date;
}

const reeId = sql.raw('"ree"."id"');
const reeOwner = sql.raw('"ree"."owner_id"');

export async function publicReeBySlug(slug: string): Promise<PublicRee | null> {
  if (!/^[a-z0-9-]{1,64}$/i.test(slug)) return null;
  const [row] = await db()
    .select({
      id: schema.ree.id,
      slug: schema.ree.slug,
      name: schema.ree.name,
      description: schema.ree.description,
      avatarBlob: schema.ree.avatarBlob,
      color: schema.ree.color,
      category: schema.ree.category,
      tags: schema.ree.tags,
      sampleQuestions: schema.ree.sampleQuestions,
      ownerId: schema.ree.ownerId,
      ownerName: schema.user.name,
      ownerAvatar: schema.user.avatarBlob,
      role: schema.user.role,
      queryFee: schema.ree.queryFee,
      sources: readySources,
      answers: answersByOthers,
      up: sql<number>`(select count(*)::int from ${schema.reeFeedback} f join ${schema.message} m on m.id = f.message_id where m.ree_id = ${reeId} and f.vote = 'up' and f.user_id <> ${reeOwner})`,
      down: sql<number>`(select count(*)::int from ${schema.reeFeedback} f join ${schema.message} m on m.id = f.message_id where m.ree_id = ${reeId} and f.vote = 'down' and f.user_id <> ${reeOwner})`,
      updatedAt: schema.ree.updatedAt,
    })
    .from(schema.ree)
    .innerJoin(schema.user, eq(schema.user.id, schema.ree.ownerId))
    .where(and(eq(schema.ree.slug, slug.toLowerCase()), publicRee()))
    .limit(1);
  if (!row) return null;
  const { up, down, ...rest } = row;
  return { ...rest, price: QUERY_BASE_FEE + row.queryFee, positiveRate: positiveRate(up, down) };
}

export interface PublicList {
  items: ReeCard[];
  total: number;
  page: number;
  pages: number;
}

/** Up to ten related public Rees, four a page; candidates share the category or a tag. */
export async function relatedFor(ree: PublicRee, page: number): Promise<PublicList> {
  const candidates = await db()
    .select({ id: schema.ree.id, ownerId: schema.ree.ownerId, name: schema.ree.name, description: schema.ree.description, category: schema.ree.category, tags: schema.ree.tags, answers: answersByOthers })
    .from(schema.ree)
    .where(and(publicRee(), ne(schema.ree.id, ree.id), or(eq(schema.ree.category, ree.category), sql`${schema.ree.tags} && ${sql.param(ree.tags)}::text[]`)))
    .orderBy(desc(sql`coalesce((${schema.ree.rank} ->> 'activity30')::int, 0)`))
    .limit(PUBLIC_RELATED_CANDIDATES);
  const ranked = relatedRees(ree, candidates);
  const pages = Math.max(1, Math.ceil(ranked.length / PUBLIC_LIST_PAGE_SIZE));
  const current = Math.min(pages, Math.max(1, page));
  const items = await reeCards(ranked.slice((current - 1) * PUBLIC_LIST_PAGE_SIZE, current * PUBLIC_LIST_PAGE_SIZE).map((row) => row.id));
  return { items, total: ranked.length, page: current, pages };
}

/** The owner's other public Rees, most answered first, paged on the server. */
export async function authorOthers(ree: PublicRee, page: number): Promise<PublicList> {
  const where = and(publicRee(), eq(schema.ree.ownerId, ree.ownerId), ne(schema.ree.id, ree.id));
  const [{ total } = { total: 0 }] = await db().select({ total: sql<number>`count(*)::int` }).from(schema.ree).where(where);
  const pages = Math.max(1, Math.ceil(total / PUBLIC_LIST_PAGE_SIZE));
  const current = Math.min(pages, Math.max(1, page));
  const ids = await db()
    .select({ id: schema.ree.id })
    .from(schema.ree)
    .where(where)
    .orderBy(desc(answersByOthers), desc(schema.ree.createdAt))
    .limit(PUBLIC_LIST_PAGE_SIZE)
    .offset((current - 1) * PUBLIC_LIST_PAGE_SIZE);
  return { items: await reeCards(ids.map((row) => row.id)), total, page: current, pages };
}
