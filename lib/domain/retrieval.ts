/**
 * Ranking without the database, ported from the old rank.ts: vector and
 * keyword recall fused by reciprocal rank, then a confidence decision on
 * whether anything recalled is evidence at all (rebuild-proposal.md 5, step 2).
 */
import { OVERVIEW_HEAD_TOKENS, OVERVIEW_TAIL_TOKENS, RETRIEVAL_MIN_SIMILARITY, RETRIEVAL_RRF_K } from '@/lib/constants';
import type { KnowledgeKind } from '@/lib/domain/knowledge';

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

/** Whether a term matches only as a whole word: Latin words do ("do" is not in "doubt"); CJK bigrams have no word boundaries. */
export function isWordTerm(term: string): boolean {
  return /^[a-z0-9]/.test(term);
}

/**
 * The pattern a whole-word term matches in lowered text. Written for both
 * JavaScript and Postgres (`~`, advanced regular expressions), so the
 * database ranks passages by the same matches `keywordCoverage` counts.
 */
export function wordPattern(term: string): string {
  return `(^|[^a-z0-9])${escapeRegExp(term)}($|[^a-z0-9])`;
}

/** Share of the question's terms a passage contains, 0..1. */
export function keywordCoverage(terms: readonly string[], content: string): number {
  if (terms.length === 0) return 0;
  const haystack = content.toLowerCase();
  const found = terms.filter((term) => (isWordTerm(term) ? new RegExp(wordPattern(term)).test(haystack) : haystack.includes(term)));
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

/* ---------------------------------------------------------------- overviews */

/**
 * Whether a question is about the sources themselves -- what there is, each
 * one, how many, a list or summary -- rather than a fact inside one. Passage
 * recall cannot answer those (no single passage speaks for a whole source),
 * so they also get each source's overview. A false positive only adds
 * context; it never takes passages away.
 */
export function isLibraryQuestion(question: string): boolean {
  /* Counting asks about the sources only with a source word after it: "how many working days" and 几个工作日 are about the content. */
  if (/\b(all|every|each|list|lists|listing|overview|overviews|summari[sz]e|summary|summaries|(?:how many|which) (?:sources?|documents?|docs?|files?|recordings?|audios?|pages?|repositories|repos?))\b/i.test(question)) return true;
  if (/(几|多少)\s*(个|份|段|篇|条)?\s*(来源|文档|文件|录音|音频|网页|页面|资料|知识|仓库)/.test(question)) return true;
  return /(所有|全部|每个|每一|每份|每段|每篇|各个|各份|各段|各自|分别|列出|列举|哪些|概览|概括|总结|汇总|总览|梳理)/.test(question);
}

const KIND_WORDS: Record<KnowledgeKind, string> = {
  audio: 'audio recording',
  document: 'document',
  github: 'code repository',
  page: 'web page',
  site: 'website',
  text: 'text note',
};

function tokenCost(character: string): number {
  return isCjk(character.codePointAt(0) ?? 0) ? 1 : 0.25;
}

/** At most `max` tokens from the start (or the end) of `text`, by the chunker's estimate. */
export function clipTokens(text: string, max: number, from: 'start' | 'end'): string {
  const characters = Array.from(text);
  if (from === 'end') characters.reverse();
  let tokens = 0;
  let kept = 0;
  for (const character of characters) {
    tokens += tokenCost(character);
    if (tokens > max) break;
    kept += 1;
  }
  const clipped = characters.slice(0, kept);
  if (from === 'end') clipped.reverse();
  return clipped.join('').trim();
}

function duration(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/**
 * A whole source in a few hundred tokens: what it is, how long, how it
 * begins and how it ends (or all of it when it is that short), and for a
 * repository or website the first of its files or pages.
 */
export function overviewText(input: {
  kind: KnowledgeKind;
  chars: number;
  parts: number;
  seconds: number | null;
  labels: readonly string[] | null;
  head: string;
  tail: string;
}): string {
  const facts = [KIND_WORDS[input.kind]];
  if (input.seconds !== null && input.seconds > 0) facts.push(`${duration(input.seconds)} long`);
  facts.push(`${input.chars.toLocaleString('en-US')} characters of text`);
  if ((input.kind === 'github' || input.kind === 'site') && input.parts > 0) facts.push(`${input.parts} ${input.kind === 'github' ? 'files' : 'pages'}`);
  const lines = [`Overview of this whole source: ${facts.join(', ')}.`];
  /* A short source fits whole: its head is all of it and within both budgets together. */
  const all = input.head.trim();
  if (input.chars <= Array.from(input.head).length && clipTokens(all, OVERVIEW_HEAD_TOKENS + OVERVIEW_TAIL_TOKENS, 'start') === all) {
    lines.push(`Full text: ${all}`);
  } else {
    lines.push(`Beginning: ${clipTokens(input.head, OVERVIEW_HEAD_TOKENS, 'start')} …`);
    lines.push(`End: … ${clipTokens(input.tail, OVERVIEW_TAIL_TOKENS, 'end')}`);
  }
  const labels = (input.labels ?? []).filter(Boolean);
  if (labels.length) lines.push(`${input.kind === 'github' ? 'Files' : 'Pages'} include: ${labels.join('; ')}${input.parts > labels.length ? '; …' : ''}`);
  return lines.join('\n');
}
