/**
 * Finding a Ree, as data (rebuild-proposal.md 2.4, 8.2 "explore 排序 / 匹配"):
 * the materialised quality signals, how relevance and quality combine, how
 * the owner's role breaks ties, the explore URL, and which public Rees a
 * public page calls related. No database here.
 */
import {
  EXPLORE_EXCERPT_CHARS,
  EXPLORE_NAME_BOOST,
  EXPLORE_TAG_WEIGHT,
  EXPLORE_BATCH_SIZES,
  PUBLIC_LIST_PAGE_SIZE,
  PUBLIC_RELATED_MAX,
  QUALITY_PRIORS,
  QUALITY_PULLS_FULL,
  QUALITY_WEIGHTS,
  REE_CATEGORIES,
  type ReeCategory,
} from '@/lib/constants';

/** What `/api/cron/rank` writes into `ree.rank` every hour; counts are of the last 30 days, other people's questions only. */
export interface ReeRank {
  asked30?: number;
  answered30?: number;
  up30?: number;
  down30?: number;
  pulls30?: number;
  /** Questions asked plus pulls into conversations: the "近 30 天活跃" order. */
  activity30?: number;
  /** Successful answers to other people, all time: the "回答最多" order. */
  answersAll?: number;
  quality?: number;
  computedAt?: string;
}

export interface QualityInput {
  asked: number;
  answered: number;
  up: number;
  down: number;
  pulls: number;
}

/**
 * The multiplier on relevance (2.4 step 3), between the floor and 1: answer
 * rate (answered / asked), share of helpful votes, and pulls into other
 * people's conversations. Smoothed so a Ree nobody has asked yet sits near
 * the middle rather than at either end.
 */
export function qualityScore(input: QualityInput): number {
  const answerRate = (input.answered + QUALITY_PRIORS.answers) / (input.asked + QUALITY_PRIORS.answers);
  const upRate = (input.up + QUALITY_PRIORS.votes / 2) / (input.up + input.down + QUALITY_PRIORS.votes);
  const pulls = Math.min(1, Math.log10(1 + input.pulls) / Math.log10(1 + QUALITY_PULLS_FULL));
  const score = QUALITY_WEIGHTS.floor + QUALITY_WEIGHTS.answerRate * Math.min(1, answerRate) + QUALITY_WEIGHTS.upRate * upRate + QUALITY_WEIGHTS.pulls * pulls;
  return Math.round(score * 10_000) / 10_000;
}

/** Quality of a Ree whose rank has not been computed yet: no questions, no votes, no pulls. */
export const NEUTRAL_QUALITY = qualityScore({ asked: 0, answered: 0, up: 0, down: 0, pulls: 0 });

export type Role = 'normal' | 'verified' | 'official';

/** Official before verified before normal -- only ever to break a tie (2.7). */
export function rolePriority(role: string | null | undefined): number {
  return role === 'official' ? 2 : role === 'verified' ? 1 : 0;
}

/** Share of helpful votes as a whole percentage, or null with no votes at all ("暂无评价"). */
export function positiveRate(up: number, down: number): number | null {
  return up + down > 0 ? Math.round((up / (up + down)) * 100) : null;
}

/* ------------------------------------------------------------------ query */

export const EXPLORE_SORTS = ['active', 'answers', 'free'] as const;
export type ExploreSort = (typeof EXPLORE_SORTS)[number];

export interface ExploreQuery {
  q: string;
  category: ReeCategory | null;
  sort: ExploreSort;
}

/** One batch of an infinitely scrolled list: where the last one ended (null for the first) and how many to take. */
export interface ExploreBatch {
  cursor: string | null;
  size: number;
}

type Params = URLSearchParams | Record<string, string | string[] | undefined>;

function read(params: Params, name: string): string {
  if (params instanceof URLSearchParams) return params.get(name) ?? '';
  const value = params[name];
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

/** prototype discovery.js `discoveryView`. */
export function parseExploreQuery(params: Params): ExploreQuery {
  const category = read(params, 'category') as ReeCategory;
  const sort = read(params, 'sort') as ExploreSort;
  return {
    q: read(params, 'q').trim().slice(0, 4_000),
    category: REE_CATEGORIES.includes(category) ? category : null,
    sort: EXPLORE_SORTS.includes(sort) ? sort : 'active',
  };
}

/** `GET /api/explore`'s `cursor` and `size`; the page itself always starts with the first batch. */
export function parseExploreBatch(params: Params): ExploreBatch {
  const size = Number(read(params, 'size'));
  return {
    cursor: read(params, 'cursor').slice(0, 512) || null,
    size: (EXPLORE_BATCH_SIZES as readonly number[]).includes(size) ? size : EXPLORE_BATCH_SIZES[0],
  };
}

/** The canonical explore path: the search, category and sort; the list itself scrolls. */
export function explorePath(query: Partial<ExploreQuery>, changes: Partial<ExploreQuery> = {}): string {
  const next = { ...query, ...changes };
  const out = new URLSearchParams();
  if (next.q) out.set('q', next.q);
  if (next.category) out.set('category', next.category);
  if (next.sort && next.sort !== 'active') out.set('sort', next.sort);
  return out.size ? `/explore?${out}` : '/explore';
}

/* ---------------------------------------------------------------- cursor */

/**
 * Where a batch ended: the last card's sort key, every part descending, the
 * id last so no two Rees tie. Opaque to the browser (base64url JSON); a
 * cursor that is not one -- edited, or from another sort -- reads as null.
 */
export type ExploreKey = (number | string)[];

const KEY_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const KEY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How many integer parts lead each sort's key; the creation time and the id follow. */
export const EXPLORE_KEY_PARTS: Record<ExploreSort, number> = { active: 3, answers: 2, free: 3 };

export function encodeExploreCursor(sort: ExploreSort, key: ExploreKey): string {
  /* Every part is ASCII (a sort name, integers, an ISO time, a uuid), so plain btoa works here and in the browser. */
  return btoa(JSON.stringify([sort, ...key])).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeExploreCursor(sort: ExploreSort, cursor: string): ExploreKey | null {
  let value: unknown;
  try {
    value = JSON.parse(atob(cursor.replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
  const ints = EXPLORE_KEY_PARTS[sort];
  if (!Array.isArray(value) || value.length !== ints + 3 || value[0] !== sort) return null;
  const key = value.slice(1) as unknown[];
  const intsOk = key.slice(0, ints).every((part) => Number.isSafeInteger(part));
  const [time, id] = key.slice(ints);
  if (!intsOk || typeof time !== 'string' || !KEY_TIME.test(time) || typeof id !== 'string' || !KEY_ID.test(id)) return null;
  return key as ExploreKey;
}

/** A public page's `from`: only ever an explore path with known fields (prototype `discoveryReturnPath`). */
export function exploreReturnPath(value: string | null | undefined): string {
  if (!value || (value !== '/explore' && !value.startsWith('/explore?'))) return '/explore';
  return explorePath(parseExploreQuery(new URLSearchParams(value.slice('/explore'.length + 1))));
}

/* --------------------------------------------------------------- ranking */

export interface Hit {
  reeId: string;
  similarity: number;
  quality: number;
  role: string;
  /** What naming the Ree adds (`nameBoost`); 0 when the query does not name it. */
  boost?: number;
}

/** Relevance × quality plus the name boost, rounded so that "相关性相同" is a real tie the role can break. */
export function hitScore(hit: Pick<Hit, 'similarity' | 'quality' | 'boost'>): number {
  return Math.round((hit.similarity * hit.quality + (hit.boost ?? 0)) * 1_000) / 1_000;
}

export function rankHits<H extends Hit>(hits: readonly H[], limit: number): H[] {
  return [...hits].sort((a, b) => hitScore(b) - hitScore(a) || rolePriority(b.role) - rolePriority(a.role) || b.similarity - a.similarity).slice(0, limit);
}

/* ------------------------------------------------- naming a Ree in a query */

/**
 * Words every docs-style Ree name carries ("Next.js Docs Assistant"), so
 * none of them names a particular Ree.
 */
const NAME_GENERIC = new Set([
  'docs', 'doc', 'documentation', 'assistant', 'assistants', 'guide', 'guides', 'official', 'ree', 'rees', 'the', 'and', 'for', 'of',
  'book', 'manual', 'handbook', 'helper', 'bot', 'companion', 'notes', 'spec', '文档', '助手', '指南', '官方', '手册', '知识库',
]);
/** Words a query is not about: what people type around a name ("how do I use nextjs"). */
const QUERY_FILLER = new Set(
  'a an the is are was were be been am do does did to of in on at by for from with and or not no it its this that these those i me my we our you your what which who when where why how can could should would will please about as into use using vs versus'.split(' '),
);
/** Common short forms of the names they stand for. */
const NAME_ALIASES: Record<string, string> = { k8s: 'kubernetes', ts: 'typescript', js: 'javascript', py: 'python', golang: 'go', postgresql: 'postgres', rn: 'reactnative' };

/**
 * A name's or query's words, compared without case, dots, hyphens or
 * underscores ("Next.js" = "nextjs" = "next-js"); Latin and CJK runs split
 * apart ("nextjs缓存" is two words), "/" and spaces separate words.
 */
export function nameWords(text: string): string[] {
  const lowered = text.normalize('NFKC').toLowerCase();
  return (lowered.match(/[a-z0-9][a-z0-9.+#_-]*|\p{Script=Han}+/gu) ?? []).map((word) => word.replace(/[._-]+/g, '')).filter(Boolean);
}

/** Each run of up to three adjacent words, joined ("next js" also reads as "nextjs"), with where it starts and ends. */
function spans(words: readonly string[]): { key: string; from: number; to: number }[] {
  const out: { key: string; from: number; to: number }[] = [];
  for (let from = 0; from < words.length; from += 1) {
    for (let to = from; to < Math.min(words.length, from + 3); to += 1) out.push({ key: words.slice(from, to + 1).join(''), from, to });
  }
  return out;
}

/** The query's words that could name something, short forms spelled out. */
export function queryNameWords(query: string): string[] {
  return nameWords(query).filter((word) => !QUERY_FILLER.has(word) && !NAME_GENERIC.has(word));
}

/** What could name a Ree in a query, for a coarse first look in the database: each word and joined run, two characters or more. */
export function queryNameKeys(query: string): string[] {
  const words = queryNameWords(query);
  return [...new Set(spans(words).flatMap(({ key }) => [key, NAME_ALIASES[key] ?? key]))].filter((key) => key.length >= 2);
}

export interface NameMatch {
  /** 0..1: the share of the Ree's distinctive name words the query names, or the tag weight for a tag. */
  signal: number;
  /** 0..1: the share of the query's words that name the Ree. */
  share: number;
}

/**
 * How strongly a query names a Ree, from its public name and tags only --
 * never its knowledge or persona. "react" names "React Docs Assistant"
 * fully, "React Router Docs Assistant" by half, and a Ree tagged "React" at
 * the tag weight; "nextjs", "next.js" and "next js" all name "Next.js".
 */
export function nameMatch(query: string, ree: { name: string; tags: readonly string[] }): NameMatch {
  const words = queryNameWords(query);
  if (!words.length) return { signal: 0, share: 0 };
  const name = nameWords(ree.name).filter((word) => !NAME_GENERIC.has(word));
  const tags = new Set(ree.tags.map((tag) => nameWords(tag).join('')).filter(Boolean));
  const covered = new Set<number>();
  const used = new Set<number>();
  let tagged = false;
  for (const span of spans(words)) {
    const key = NAME_ALIASES[span.key] ?? span.key;
    let hit = false;
    for (const part of spans(name)) {
      if (part.key !== key) continue;
      for (let at = part.from; at <= part.to; at += 1) covered.add(at);
      hit = true;
    }
    if (tags.has(key)) tagged = hit = true;
    if (hit) for (let at = span.from; at <= span.to; at += 1) used.add(at);
  }
  const signal = Math.max(name.length ? covered.size / name.length : 0, tagged ? EXPLORE_TAG_WEIGHT : 0);
  return signal > 0 ? { signal, share: used.size / words.length } : { signal: 0, share: 0 };
}

/** What naming a Ree adds to its score: a full name, alone in the query, adds the whole boost. */
export function nameBoost(match: NameMatch): number {
  return Math.round(EXPLORE_NAME_BOOST * match.signal * match.share * 1_000) / 1_000;
}

/** About 160 characters of the matched passage, starting near the first word the question shares with it. */
export function excerptOf(content: string, terms: readonly string[]): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  const lower = flat.toLowerCase();
  const first = terms.map((term) => lower.indexOf(term)).filter((at) => at >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = first > 60 ? first - 40 : 0;
  const cut = flat.slice(start, start + EXPLORE_EXCERPT_CHARS);
  return `${start ? '…' : ''}${cut}${flat.length > start + EXPLORE_EXCERPT_CHARS ? '…' : ''}`;
}

/* -------------------------------------------------- public page: related */

export interface PublicMeta {
  id: string;
  ownerId: string;
  name: string;
  description: string;
  category: string;
  tags: readonly string[];
  answers: number;
}

const GENERIC = new Set([
  'the', 'and', 'for', 'with', 'your', 'ree', 'rees', 'notes', 'guide', 'handbook', 'knowledge', 'practice', 'methods',
  '知识', '笔记', '手册', '指南', '实践', '方法', '整理', '档案', '伙伴', '内容', '案例', '经验', '相关', '问题',
]);

function tokens(text: string): Set<string> {
  const value = text.normalize('NFKC').toLowerCase();
  const out = new Set(value.match(/[a-z][a-z0-9+#-]{1,}/g) ?? []);
  for (const phrase of value.match(/\p{Script=Han}{2,}/gu) ?? []) for (let at = 0; at < phrase.length - 1; at += 1) out.add(phrase.slice(at, at + 2));
  return new Set([...out].filter((token) => !GENERIC.has(token)));
}

function overlap(a: Set<string>, b: Set<string>): number {
  const shared = [...a].filter((value) => b.has(value)).length;
  return shared ? shared / (a.size + b.size - shared) : 0;
}

/**
 * How alike two public Rees are from what they show publicly -- name,
 * introduction, tags and category, never knowledge or the persona prompt
 * (prototype public-ree-recommendations.js).
 */
export function publicSimilarity(a: PublicMeta, b: PublicMeta): number {
  const tagsA = new Set(a.tags.map((tag) => tag.normalize('NFKC').toLowerCase().trim()));
  const tags = b.tags.filter((tag) => tagsA.has(tag.normalize('NFKC').toLowerCase().trim())).length;
  const category = a.category !== 'other' && a.category === b.category;
  const title = overlap(tokens(a.name), tokens(b.name));
  if (!tags && !category && !title) return 0;
  return tags * 3 + (category ? 2 : 0) + title * 8 + overlap(tokens(a.description), tokens(b.description));
}

export function relatedRees<M extends PublicMeta>(current: PublicMeta, candidates: readonly M[]): M[] {
  return candidates
    .filter((candidate) => candidate.id !== current.id)
    .map((candidate) => ({ candidate, score: publicSimilarity(current, candidate) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || b.candidate.answers - a.candidate.answers || a.candidate.id.localeCompare(b.candidate.id))
    .slice(0, PUBLIC_RELATED_MAX)
    .map((row) => row.candidate);
}

/** A public page's tags: none that repeats the category label, each once, case aside (prototype public-dot.js `overview`). */
export function publicTags(tags: readonly string[], categoryLabel: string): string[] {
  const key = (value: string) => value.normalize('NFKC').trim().toLowerCase();
  const seen = new Set([key(categoryLabel)]);
  return tags.filter((tag) => {
    const value = key(tag);
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

/** One page of four, the page pulled back into range. */
export function pageOf<T>(rows: readonly T[], requested: number): { items: T[]; total: number; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(rows.length / PUBLIC_LIST_PAGE_SIZE));
  const page = Math.min(pages, Math.max(1, Math.floor(Number(requested) || 1)));
  return { items: rows.slice((page - 1) * PUBLIC_LIST_PAGE_SIZE, page * PUBLIC_LIST_PAGE_SIZE), total: rows.length, page, pages };
}
