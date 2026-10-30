/**
 * The asset profile: what an asset is *about*, derived from its content.
 *
 * architecture.md 9.6 -- on a platform where anyone can upload an asset, the
 * name the owner typed carries no routing signal (the rove-beetle article
 * lives in an asset called "昆虫大全"). Asset-level discovery therefore
 * searches a content-derived profile, never the display name: the document
 * titles, a term table extracted from the chunk bodies, and a handful of
 * centroid vectors that stand in for the asset's topic clusters.
 *
 * Everything here is derived data (architecture.md 6.4): rebuildable from the
 * published version's content, written in the `profile` step of a build
 * (architecture.md 8.2), and never edited afterwards.
 *
 * Pure TypeScript, like the rest of the domain layer. The extraction is the
 * statistical baseline architecture.md 22 leaves open to revision -- what must
 * stay fixed is the shape: titles + terms + centroids, versioned by
 * PROFILE_VERSION so a smarter extractor rebuilds rather than mixes.
 */

/** Frozen into `asset_profile.profile_version`; bump on any change here. */
export const PROFILE_VERSION = 're0-profile-4';

export const PROFILE_LIMITS = {
  /** Titles kept on the profile row. Routing only needs the vocabulary. */
  maxTitles: 500,
  /** Terms kept from the extraction below. */
  maxTerms: 256,
  /**
   * Centroids per asset. Enough that an encyclopedic asset's topic
   * clusters each get a representative (architecture.md 9.6: one summary
   * vector dilutes them), few enough that the platform-wide vector table
   * stays assets x centroids, not chunks.
   */
  maxCentroids: 32,
} as const;

/* -------------------------------------------------------------- stopwords */

/**
 * Words that say nothing about what an asset is about.
 *
 * Without this list the profile of a large English asset is half function
 * words -- "the", "and", "for", "that" outnumber every real term, and the
 * 256 slots fill before "eth" or "staking" get one -- and a question that
 * contains "the" matches every profile on the platform. The list is
 * deliberately short: function words, pronouns, auxiliaries, and the handful
 * of verbs and nouns every question is made of ("how do I use", "show me an
 * example"). Product words are never here, however common: "next", "page",
 * "router" and "install" are what some asset is about.
 *
 * The Han entries are the question-shaped grams ("什么", "怎么", "如何")
 * that the 2-4 gram segmentation would otherwise turn into terms.
 */
const STOPWORDS = new Set([
  ...`a an the and or but nor not no if then else than as at by for from in into of off on onto
  to up down out over under with within without about above below between through during before
  after again further once here there where when why how what which who whom whose this that
  these those is are was were be been being am do does did doing done have has had having
  i me my mine we us our ours you your yours he him his she her hers it its they them their
  theirs itself myself yourself ourselves themselves all any both each few more most other
  others some such only own same so too very can could will would shall should may might must
  also just ever never always often still yet already even much many every either neither via
  per etc use using used uses make makes making made get gets getting got set sets need needs
  needed want wants wanted show shows showing tell tells give gives take takes see seen let
  know like way ways thing things something anything nothing please help work works working
  write read example examples latest
  first second third last previous new old one two three four five six seven eight nine ten
  hundred thousand because however therefore thus although though whereas since until unless
  whether another again number numbers provide provides provided providing allow allows allowed
  allowing include includes included including based simply different various certain
  particular specific important possible able following follows note notes`.split(/\s+/),
  ...['什么', '怎么', '怎样', '如何', '为什么', '是什么', '怎么做', '怎么办', '怎么样', '什么是',
    '哪些', '哪个', '哪里', '可以', '能否', '是否', '如果', '我们', '你们', '他们', '这个', '那个',
    '这些', '那些', '一个', '一下', '一些', '请问', '有没有', '没有', '或者', '以及', '但是', '因为',
    '所以', '关于', '需要', '应该', '的', '了', '是', '在', '和', '与', '或', '吗', '呢'],
]);

export function isStopword(token: string): boolean {
  return STOPWORDS.has(token);
}

/* ------------------------------------------------------------ boilerplate */

/**
 * Phrases a documentation site prints on every page and a crawl keeps as
 * text: link decorations, skip links, page furniture. Measured on
 * ethereum.org: "(opens in a new tab)" sat in 42% of all chunks and put
 * `new`, `opens`, `tab` at the head of the profile ahead of every real term;
 * "skip to main content" and "edit page" once per page. They are removed
 * before tokenizing rather than stopworded word by word, because "open" and
 * "tab" are ordinary words an asset can genuinely be about.
 *
 * Phrases only, and only ones that are furniture on any site. An asset's
 * own recurring heading is content, and stays.
 */
const BOILERPLATE: readonly RegExp[] = [
  /\(?\s*opens? in a new (?:tab|window)\s*\)?/giu,
  /\bskip to (?:main )?content\b/giu,
  /\bedit (?:this )?page\b/giu,
  /\bon this page\b/giu,
  /\btable of contents\b/giu,
  /\bback to top\b/giu,
  /\b(?:read|learn) more\b/giu,
  /\bcopy (?:link|to clipboard)\b/giu,
  /\blast (?:edit|updated?)(?: on)?\b/giu,
  /在新(?:标签页|窗口)中?打开/gu,
  /跳(?:转到|转|到)(?:主要|正文)内容/gu,
  /编辑(?:此|本)页/gu,
  /本页(?:目录|内容)/gu,
];

/**
 * Addresses inside the text: URLs, e-mail addresses, and bare hostnames or
 * file paths (`cdnjs.cloudflare.com/ajax/libs/twemoji/...svg`). Measured on
 * ethereum.org: image and link targets that survived Markdown conversion put
 * `https`, `svg`, `com`, `cdnjs` and `ajax` in the profile's top ten. An
 * address is where a page points, not what it is about.
 */
const ADDRESSES: readonly RegExp[] = [
  /\bhttps?:\/\/[^\s<>()"']+/giu,
  /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/giu,
  /\b(?:[\w-]+\.)+(?:com|org|net|io|dev|app|xyz|ai|co|edu|gov)\b(?:\/[^\s<>()"']*)?/giu,
];

/** The text with site furniture and addresses removed; what the extractor counts. */
export function stripBoilerplate(text: string): string {
  let out = text;
  for (const pattern of ADDRESSES) out = out.replace(pattern, ' ');
  for (const pattern of BOILERPLATE) out = out.replace(pattern, ' ');
  return out;
}

/* ------------------------------------------------------------------ terms */

/**
 * Word runs for space-delimited scripts; Han runs handled separately below.
 * Latin terms shorter than three characters are mostly stopwords and markup.
 */
const WORD_RUN = /[\p{L}\p{N}][\p{L}\p{N}_-]*/gu;
const HAN_RUN = /\p{Script=Han}+/gu;
/** Unanchored and non-global: `.test` on a global regex keeps state between calls. */
const HAS_HAN = /\p{Script=Han}/u;

/**
 * Extract the terms that characterise a set of texts.
 *
 * Two token streams, because the failure modes differ by script:
 *
 * - Space-delimited words are counted as-is, lowercased, dropping runs shorter
 *   than three characters or made only of digits.
 * - Han runs are counted as n-grams of two to four characters. This is the
 *   pre-segmentation escape hatch architecture.md 22 records: stock Postgres
 *   cannot segment CJK, so the profile carries terms that are already split,
 *   and `to_tsvector('simple', ...)` over space-joined terms indexes them
 *   correctly. Longer grams score higher (count x length), and a gram that is
 *   contained in a kept longer gram with comparable frequency is absorbed --
 *   「隐翅虫」 survives, its 「隐翅」 shadow does not.
 *
 * Deterministic: same texts, same terms, same order.
 */
export function extractTerms(
  texts: readonly string[],
  limit: number = PROFILE_LIMITS.maxTerms,
  weight: TermWeight = () => 1,
): string[] {
  const counts = new Map<string, number>();
  const bump = (term: string, by: number) => counts.set(term, (counts.get(term) ?? 0) + by);

  for (const raw of texts) {
    const text = stripBoilerplate(raw);
    for (const match of text.matchAll(WORD_RUN)) {
      const run = match[0];
      if (HAS_HAN.test(run)) continue; // counted below, as grams
      const word = run.toLowerCase();
      if (word.length < 3 || /^[\p{N}_-]+$/u.test(word) || isStopword(word)) continue;
      bump(word, 1);
    }
    for (const match of text.matchAll(HAN_RUN)) {
      /* By code point: UTF-16 slicing would split astral Han characters. */
      const chars = Array.from(match[0]);
      for (let size = 2; size <= 4; size += 1) {
        for (let at = 0; at + size <= chars.length; at += 1) {
          const gram = chars.slice(at, at + size).join('');
          if (!isStopword(gram)) bump(gram, size);
        }
      }
    }
  }

  /*
   * Frequency times specificity. Frequency alone ranks whatever a site says
   * most, and every documentation site says "information", "users" and
   * "account" a lot; the weight is where the platform's other assets get
   * a say in what is distinctive about this one (`platformSpecificity`).
   */
  const ranked = [...counts.entries()]
    .map(([term, tally]) => [term, tally * weight(term)] as const)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  /*
   * Absorption is for Han grams only. A shorter gram inside a kept longer
   * one with comparable frequency is that gram's shadow (「隐翅」 under
   * 「隐翅虫」). A latin word inside a longer latin word is a different word:
   * "eth" is not a shadow of "ethereum", nor "validator" of "validators",
   * and absorbing them once kept the corpus's own name out of its profile.
   */
  const kept: { term: string; score: number; han: boolean }[] = [];
  for (const [term, score] of ranked) {
    if (kept.length >= limit) break;
    const han = HAS_HAN.test(term);
    const absorbed =
      han &&
      kept.some(
        (longer) =>
          longer.han &&
          longer.term.length > term.length &&
          longer.term.includes(term) &&
          score <= longer.score * 2,
      );
    if (!absorbed) kept.push({ term, score, han });
  }

  return kept.map((entry) => entry.term);
}

/** A multiplier per term, applied to its frequency before ranking. */
export type TermWeight = (term: string) => number;

/**
 * Inverse document frequency across the platform's assets: a term that
 * sits in the profile of most other assets says little about this one.
 *
 * `assets` is how many other assets have a profile, `frequency` how
 * many of them carry the term. The smoothed log keeps a term nobody else has
 * at its full count and takes a term everybody has down towards a third of
 * it -- a dampener, not a veto, because an asset about the very thing every
 * other asset mentions in passing still needs the word in its profile.
 * With few assets on the platform the weights stay close to one, which
 * is the honest answer: there is not yet evidence that a term is generic.
 */
export function platformSpecificity(
  frequency: ReadonlyMap<string, number>,
  assets: number,
): TermWeight {
  if (assets <= 0) return () => 1;
  const ceiling = Math.log(assets + 1) + 1;
  return (term) => (Math.log((assets + 1) / ((frequency.get(term) ?? 0) + 1)) + 1) / ceiling;
}

/**
 * The text the profile's keyword index is generated from.
 *
 * Space-joined and deduplicated, so `to_tsvector('simple', ...)` sees one
 * token per title word and per extracted term -- pre-segmented, which is what
 * makes the profile searchable for CJK content while `chunk.search_vector`
 * cannot be (architecture.md 9.6, 22). Whole titles are folded through the
 * same tokenizer so a title contributes its words, not one unsplittable blob.
 */
export function profileSearchText(titles: readonly string[], terms: readonly string[]): string {
  const tokens = new Set<string>();
  for (const title of titles) collectTokens(title, tokens);
  for (const term of terms) tokens.add(term);
  return [...tokens].join(' ');
}

/**
 * The same segmentation, applied to a query. A query and the profile index
 * must be split by one tokenizer or CJK never matches: the profile stores
 * 「隐翅虫」 as its own token, so the query side has to produce that token
 * from 「隐翅虫的防治」 too. architecture.md 9.6.
 */
export function searchTokens(text: string): string[] {
  const tokens = new Set<string>();
  collectTokens(text, tokens);
  return [...tokens];
}

/**
 * The tokens of a question that can say which asset it is about: the
 * same segmentation, minus the stopwords above. Routing recalls and gathers
 * evidence with these, so "how do I write the" matches nothing, while the
 * chunk-level retrieval inside an asset keeps every token -- there, the
 * version's own text-search configuration decides what a stopword is.
 */
export function routingTokens(text: string): string[] {
  return searchTokens(text).filter((token) => !isStopword(token));
}

function collectTokens(text: string, into: Set<string>): void {
  for (const match of text.matchAll(WORD_RUN)) {
    const run = match[0];
    if (HAS_HAN.test(run)) {
      into.add(run);
      /* By code point: UTF-16 slicing would split astral Han characters. */
      const chars = Array.from(run);
      for (let size = 2; size <= 4; size += 1) {
        for (let at = 0; at + size <= chars.length; at += 1) {
          into.add(chars.slice(at, at + size).join(''));
        }
      }
    } else {
      into.add(run.toLowerCase());
    }
  }
}

/* -------------------------------------------------------------- centroids */

/**
 * Online k-means over a stream of embeddings.
 *
 * The build embeds in windows and drops each window's vectors as soon as the
 * rows are written (build-version.ts keeps peak memory flat whatever the size
 * of the asset), so the centroids must be computed the same way: feed each
 * window in, keep only k running means. One pass, no stored vectors.
 *
 * Seeding is the first k vectors -- deterministic, and biased toward the first
 * documents, which is acceptable for a routing signal and recorded as part of
 * the baseline architecture.md 22 leaves open. No randomness anywhere: a
 * rebuilt version must produce the same profile.
 *
 * Vectors are normalised on the way in and the means on the way out, so the
 * centroids live in the same cosine space the query embedding is compared in.
 */
export class CentroidAccumulator {
  private readonly means: Float64Array[] = [];
  private readonly counts: number[] = [];

  constructor(private readonly k: number = PROFILE_LIMITS.maxCentroids) {}

  /**
   * A vector this close to an existing seed joins it instead of taking a
   * seat of its own. Near-duplicate chunks (boilerplate, repeated sections)
   * would otherwise fill the seeding phase with copies of one topic.
   */
  private static readonly SEED_DUPLICATE_DOT = 0.995;

  add(vector: readonly number[]): void {
    const unit = normalize(vector);
    if (!unit) return;

    let best = -1;
    let bestDot = -Infinity;
    for (let at = 0; at < this.means.length; at += 1) {
      const dot = dotProduct(this.means[at]!, unit);
      if (dot > bestDot) {
        bestDot = dot;
        best = at;
      }
    }

    const seeding = this.means.length < this.k;
    if (seeding && bestDot < CentroidAccumulator.SEED_DUPLICATE_DOT) {
      this.means.push(unit);
      this.counts.push(1);
      return;
    }

    const mean = this.means[best]!;
    const n = (this.counts[best] = (this.counts[best] ?? 0) + 1);
    for (let at = 0; at < mean.length; at += 1) {
      mean[at]! += (unit[at]! - mean[at]!) / n;
    }
  }

  /** Unit-length centroids, in seeding order. Empty when nothing was added. */
  centroids(): number[][] {
    const out: number[][] = [];
    for (const mean of this.means) {
      const unit = normalize(mean);
      if (unit) out.push(Array.from(unit));
    }
    return out;
  }
}

function normalize(vector: ArrayLike<number>): Float64Array | null {
  let sum = 0;
  for (let at = 0; at < vector.length; at += 1) sum += vector[at]! * vector[at]!;
  if (sum === 0) return null;
  const scale = 1 / Math.sqrt(sum);
  const out = new Float64Array(vector.length);
  for (let at = 0; at < vector.length; at += 1) out[at] = vector[at]! * scale;
  return out;
}

function dotProduct(a: Float64Array, b: Float64Array): number {
  let sum = 0;
  for (let at = 0; at < a.length; at += 1) sum += a[at]! * b[at]!;
  return sum;
}
