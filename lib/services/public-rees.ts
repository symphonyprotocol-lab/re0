/**
 * The public page `/r/[slug]` (rebuild-proposal.md 2.4, 8.2 "公开页提问"):
 * what it shows of a public Ree -- never the knowledge itself, only the
 * number of ready sources -- and its two lists, related Rees (from public
 * names, introductions, tags and category only) and the owner's other
 * public Rees.
 */
import { and, asc, desc, eq, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { PUBLIC_LIST_PAGE_SIZE, PUBLIC_RELATED_CANDIDATES, QUERY_BASE_FEE, REE_CATEGORIES, type ReeCategory } from '@/lib/constants';
import { positiveRate, relatedRees } from '@/lib/domain/explore';
import type { SocialContact } from '@/lib/domain/account';
import { isUuid } from '@/lib/domain/list';
import { isShareStyle, productSheetOf, type ProductSheet, type ShareStyle } from '@/lib/domain/share-style';
import { db, schema } from '@/lib/infra/db';
import { answersByOthers, publicRee, readySources, reeCards, type ReeCard } from '@/lib/services/explore';
import { votesByOthers } from '@/lib/services/ree-feedback';

export interface PublicRee {
  id: string;
  slug: string;
  name: string;
  description: string;
  avatarBlob: string | null;
  coverBlob: string | null;
  color: string;
  category: string;
  tags: string[];
  sampleQuestions: string[];
  ownerId: string;
  ownerName: string;
  ownerAvatar: string | null;
  ownerTitle: string;
  ownerDescription: string;
  ownerWebsite: string;
  ownerSocialContacts: SocialContact[];
  role: 'normal' | 'verified' | 'official';
  queryFee: number;
  /** v5: it answers public posts (the owner's choice, or free by default), so 发帖问它 can name it. */
  takesPosts: boolean;
  /** The owner lets askers publish answers on the page (问答); off, the page offers no "回答后公开". */
  publicQaEnabled: boolean;
  /** The owner lets signed-out visitors ask on the share page, paying for their answers (lib/domain/visitor-ask.ts). */
  visitorAsks: boolean;
  /** How the share page lays it out, and the owner's product sheet for the `product` style (lib/domain/share-style.ts). */
  shareStyle: ShareStyle;
  productSheet: ProductSheet;
  price: number;
  sources: number;
  answers: number;
  positiveRate: number | null;
  updatedAt: Date;
}

export async function publicReeBySlug(slug: string): Promise<PublicRee | null> {
  if (!validSlug(slug)) return null;
  return reeDetails(and(eq(schema.ree.slug, slug.toLowerCase()), publicRee())!);
}

export async function reeForPreview(id: string, ownerId: string): Promise<PublicRee | null> {
  if (!isUuid(id)) return null;
  return reeDetails(and(eq(schema.ree.id, id), eq(schema.ree.ownerId, ownerId), isNull(schema.ree.deletedAt))!);
}

export async function coverVisibleTo(id: string, pathname: string, viewerId: string | null): Promise<boolean> {
  const [row] = await db().select({ id: schema.ree.id }).from(schema.ree)
    .where(and(
      eq(schema.ree.id, id),
      eq(schema.ree.coverBlob, pathname),
      isNull(schema.ree.deletedAt),
      or(viewerId ? eq(schema.ree.ownerId, viewerId) : undefined, publicRee()),
    ))
    .limit(1);
  return Boolean(row);
}

async function reeDetails(where: SQL): Promise<PublicRee | null> {
  const [row] = await db()
    .select({
      id: schema.ree.id,
      slug: schema.ree.slug,
      name: schema.ree.name,
      description: schema.ree.description,
      avatarBlob: schema.ree.avatarBlob,
      coverBlob: schema.ree.coverBlob,
      color: schema.ree.color,
      category: schema.ree.category,
      tags: schema.ree.tags,
      sampleQuestions: schema.ree.sampleQuestions,
      ownerId: schema.ree.ownerId,
      ownerName: schema.user.name,
      ownerAvatar: schema.user.avatarBlob,
      ownerTitle: schema.user.title,
      ownerDescription: schema.user.description,
      ownerWebsite: schema.user.website,
      ownerSocialContacts: schema.user.socialContacts,
      role: schema.user.role,
      queryFee: schema.ree.queryFee,
      takesPosts: sql<boolean>`coalesce(${schema.ree.answersPosts}, ${schema.ree.queryFee} = 0)`,
      publicQaEnabled: schema.ree.publicQaEnabled,
      visitorAsks: schema.ree.visitorAsks,
      shareStyle: schema.ree.shareStyle,
      productSheet: schema.ree.productSheet,
      sources: readySources,
      answers: answersByOthers,
      up: votesByOthers('up'),
      down: votesByOthers('down'),
      updatedAt: schema.ree.updatedAt,
    })
    .from(schema.ree)
    .innerJoin(schema.user, eq(schema.user.id, schema.ree.ownerId))
    .where(where)
    .limit(1);
  if (!row) return null;
  const { up, down, shareStyle, productSheet, ...rest } = row;
  return { ...rest, shareStyle: isShareStyle(shareStyle) ? shareStyle : 'default', productSheet: productSheetOf(productSheet), price: QUERY_BASE_FEE + row.queryFee, positiveRate: positiveRate(up, down) };
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

/** The Ree whose owner's other public Rees are listed: its id and owner are all the list needs. */
type AuthorOf = Pick<PublicRee, 'id' | 'ownerId'>;

/** The owner's other public Rees, most answered first, paged on the server. */
export async function authorOthers(ree: AuthorOf, page: number): Promise<PublicList> {
  const where = authorOthersWhere(ree);
  const total = await authorOthersTotal(ree);
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

/**
 * 同一创作者的更多 Ree for the public Ree with this id, or null when there is
 * none: the page's pager (`GET /api/rees/[id]/author-rees?page=`), which
 * pages in place rather than through `?ap=` links a crawler would follow.
 */
export async function publicAuthorOthers(id: string, page: number): Promise<PublicList | null> {
  if (!isUuid(id)) return null;
  const [row] = await db().select({ id: schema.ree.id, ownerId: schema.ree.ownerId }).from(schema.ree).where(and(eq(schema.ree.id, id), publicRee())).limit(1);
  return row ? authorOthers(row, page) : null;
}

function authorOthersWhere(ree: AuthorOf) {
  return and(publicRee(), eq(schema.ree.ownerId, ree.ownerId), ne(schema.ree.id, ree.id));
}

async function authorOthersTotal(ree: AuthorOf): Promise<number> {
  const [{ total } = { total: 0 }] = await db().select({ total: sql<number>`count(*)::int` }).from(schema.ree).where(authorOthersWhere(ree));
  return total;
}

/** How many pages 同一创作者的更多 Ree has (`?ap=`), at least one. */
export async function authorOthersPages(ree: AuthorOf): Promise<number> {
  return Math.max(1, Math.ceil((await authorOthersTotal(ree)) / PUBLIC_LIST_PAGE_SIZE));
}

/** A slug as the public page and the share page accept it. */
function validSlug(slug: string): boolean {
  return /^[a-z0-9-]{1,64}$/i.test(slug);
}

/** Just enough of a public Ree to act on its slug (the share page's beacons): the same gate as `publicReeBySlug`. */
export async function publicReeRef(slug: string): Promise<{ id: string; ownerId: string } | null> {
  if (!validSlug(slug)) return null;
  const [row] = await db()
    .select({ id: schema.ree.id, ownerId: schema.ree.ownerId })
    .from(schema.ree)
    .where(and(eq(schema.ree.slug, slug.toLowerCase()), publicRee()))
    .limit(1);
  return row ?? null;
}

/**
 * The owner's most recently changed public Ree, behind the same gate as its
 * share page (`publicRee()`): what 首页's 分享 card opens the share dialog
 * for. Null when the owner has no public Ree yet.
 */
export async function ownShareableRee(ownerId: string): Promise<{ name: string; slug: string } | null> {
  if (!isUuid(ownerId)) return null;
  const [row] = await db()
    .select({ name: schema.ree.name, slug: schema.ree.slug })
    .from(schema.ree)
    .where(and(eq(schema.ree.ownerId, ownerId), publicRee()))
    .orderBy(desc(schema.ree.updatedAt), desc(schema.ree.id))
    .limit(1);
  return row?.slug ? { name: row.name, slug: row.slug } : null;
}

/** A public Ree as the sitemap lists it (app/sitemap.ts): its URL, when it changed, and whose it is (lib/seo.ts `reeContentLocale`). */
export interface SitemapRee {
  slug: string;
  role: PublicRee['role'];
  updatedAt: Date;
}

/**
 * Public Rees for the sitemap, oldest first (then by id), so a Ree keeps
 * its sitemap file as newer ones are added: the same `publicRee()` gate as
 * the page -- public, published, not taken down, not deleted.
 */
export async function sitemapRees({ offset, limit }: { offset: number; limit: number }): Promise<SitemapRee[]> {
  return db()
    .select({ slug: schema.ree.slug, role: schema.user.role, updatedAt: schema.ree.updatedAt })
    .from(schema.ree)
    .innerJoin(schema.user, eq(schema.user.id, schema.ree.ownerId))
    .where(publicRee())
    .orderBy(asc(schema.ree.createdAt), asc(schema.ree.id))
    .offset(offset)
    .limit(limit);
}

/** How many public Rees there are, and when the latest of them changed (Explore's `<lastmod>`). */
export async function sitemapReeTotals(): Promise<{ total: number; latest: Date | null }> {
  const [row] = await db()
    .select({ total: sql<number>`count(*)::int`, latest: sql<Date | null>`max(${schema.ree.updatedAt})`.mapWith(schema.ree.updatedAt) })
    .from(schema.ree)
    .where(publicRee());
  return { total: row?.total ?? 0, latest: row?.latest ?? null };
}

/**
 * The Explore categories that have public Rees, in the order the page lists
 * its category links (`REE_CATEGORIES`), each with when its latest Ree
 * changed: the same filter as the category's list (lib/services/explore.ts
 * `explore`), so an empty category -- a page with no Rees -- is left out.
 */
export async function sitemapReeCategories(): Promise<{ category: ReeCategory; latest: Date }[]> {
  const rows = await db()
    .select({ category: schema.ree.category, latest: sql<Date>`max(${schema.ree.updatedAt})`.mapWith(schema.ree.updatedAt) })
    .from(schema.ree)
    .where(publicRee())
    .groupBy(schema.ree.category);
  const latest = new Map(rows.map((row) => [row.category, row.latest]));
  return REE_CATEGORIES.flatMap((category) => (latest.has(category) ? [{ category, latest: latest.get(category)! }] : []));
}
