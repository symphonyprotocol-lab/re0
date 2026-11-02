/**
 * Ranking without the database, ported from the old rank.ts: vector and
 * keyword recall fused by reciprocal rank, then a confidence decision on
 * whether anything recalled is evidence at all (rebuild-proposal.md 5, step 2).
 */
import { RETRIEVAL_MIN_SIMILARITY, RETRIEVAL_RRF_K } from '@/lib/constants';

function isCjk(code: number): boolean {
  return (code >= 0x3400 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff);
}

/** Words that carry no evidence: matching them says nothing about whether a passage answers. */
const STOPWORDS = new Set(
  'a an the is are was were be been am do does did to of in on at by for from with and or not no it its this that these those i me my we our you your he she they them his her their what which who whom when where why how can could should would will shall may might must please about as into than then there here so if'.split(
    ' ',
  ),
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Search terms of a question: Latin words of two or more characters that are
 * not stopwords, and CJK bigrams (Chinese has no spaces to split on, and
 * single characters match almost everything).
 */
export function searchTerms(text: string): string[] {
  const terms = new Set<string>();
  for (const word of text.toLowerCase().match(/[a-z0-9][a-z0-9._-]+/g) ?? []) if (!STOPWORDS.has(word)) terms.add(word);
  const chars = Array.from(text);
  for (let at = 0; at < chars.length - 1; at += 1) {
    const a = chars[at]!.codePointAt(0) ?? 0;
    const b = chars[at + 1]!.codePointAt(0) ?? 0;
    if (isCjk(a) && isCjk(b)) terms.add(chars[at]! + chars[at + 1]!);
  }
  return [...terms].slice(0, 24);
}

/** Share of the question's terms a passage contains, 0..1. */
export function keywordCoverage(terms: readonly string[], content: string): number {
  if (terms.length === 0) return 0;
  const haystack = content.toLowerCase();
  /* Latin words must match whole words ("do" is not in "doubt"); CJK bigrams have no word boundaries. */
  const found = terms.filter((term) =>
    /^[a-z0-9]/.test(term) ? new RegExp(`(^|[^a-z0-9])${escapeRegExp(term)}($|[^a-z0-9])`).test(haystack) : haystack.includes(term),
  );
  return found.length / terms.length;
}

/** Reciprocal rank fusion over any number of ranked id lists. */
export function fuse(lists: readonly (readonly string[])[], k = RETRIEVAL_RRF_K): string[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, index) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1)));
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/**
 * Whether recall found evidence: the nearest passage is close enough, or a
 * passage holds most of a multi-term question word for word.
 */
export function hasEvidence(input: { bestSimilarity: number | null; bestCoverage: number; terms: number }): boolean {
  if (input.bestSimilarity !== null && input.bestSimilarity >= RETRIEVAL_MIN_SIMILARITY) return true;
  return input.terms >= 2 && input.bestCoverage >= 0.75;
}
