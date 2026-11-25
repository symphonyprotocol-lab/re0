import { plainOf, previewOf } from '@/lib/domain/public-qa';

/**
 * A public Ree page's "Answered questions" (GSC review 2026-11, 6.8 #2-3,
 * B8): two or three real posts this Ree answered, shown on the page itself
 * so a visitor and a search engine read an answer, not only "an assistant
 * for X". Each is the question, the opening sentences of the answer with
 * its citation markers, and the post it came from.
 */
export interface ReeExample {
  postId: string;
  question: string;
  /** The post's language: the question's and the answer's. */
  lang: 'zh' | 'en';
  /** The answer's opening sentences as plain text, `[n]` markers kept. */
  summary: string;
  /** The cited sources' titles by marker number. */
  sources: { index: number; title: string }[];
}

/** How many examples a Ree page shows. */
export const REE_EXAMPLES = 3;
/** How much of an answer the query reads: enough Markdown for three sentences, never the whole answer. */
export const REE_EXAMPLE_READ_CHARS = 1_000;
/** The summary's sentences and its length at most. */
export const REE_EXAMPLE_SENTENCES = 3;
export const REE_EXAMPLE_SUMMARY_CHARS = 320;
/** A meta description's length, about what a search result shows. */
export const META_DESCRIPTION_CHARS = 155;

/** A run of citation markers, "[1]" or "[1][2]" or "[1, 2]". */
const MARKERS = /\s*(?:\[\d{1,2}(?:\s*[,，]\s*\d{1,2})*\])+/g;
/* A sentence ends at . ! ? before a space, a marker or the end (not in "3.5" or "e.g.x"), or at 。！？, with the markers that follow it. */
const SENTENCE_END = /(?:[.!?](?=\s|\[|$)|[。！？])(?:\s*\[\d{1,2}(?:\s*[,，]\s*\d{1,2})*\])*/g;

/** Two stretches of text as one: no space after a full-width stop (。！？), as Chinese is written. */
function joined(first: string, second: string): string {
  return /[。！？；：，、）」』]$/.test(first) ? `${first}${second}` : `${first} ${second}`;
}

/** Plain text split into sentences, each keeping the citation markers that close it. */
export function sentencesOf(text: string): string[] {
  const sentences: string[] = [];
  let at = 0;
  for (const match of text.matchAll(SENTENCE_END)) {
    const end = (match.index ?? 0) + match[0].length;
    const sentence = text.slice(at, end).trim();
    if (sentence) sentences.push(sentence);
    at = end;
  }
  const rest = text.slice(at).trim();
  if (rest) sentences.push(rest);
  return sentences;
}

/**
 * An answer's opening as a page shows it under its question: the Markdown
 * as plain text, its first sentences up to `REE_EXAMPLE_SENTENCES` and
 * `REE_EXAMPLE_SUMMARY_CHARS`; a first sentence longer than that is cut on
 * a word, never inside a marker. `text` may itself be cut (the query reads
 * `REE_EXAMPLE_READ_CHARS`), so a sentence the cut left unfinished at the
 * end is not counted as one.
 */
export function answerSummary(text: string, cut = false): string {
  const sentences = sentencesOf(plainOf(text));
  if (cut && sentences.length > 1) sentences.pop();
  const [first, ...rest] = sentences;
  if (!first) return '';
  let summary = previewOf(first, REE_EXAMPLE_SUMMARY_CHARS).answer;
  for (const sentence of rest.slice(0, REE_EXAMPLE_SENTENCES - 1)) {
    const next = joined(summary, sentence);
    if (next.length > REE_EXAMPLE_SUMMARY_CHARS) break;
    summary = next;
  }
  return summary;
}

/** Text without its citation markers, for where none can be shown (a meta description). */
export function withoutMarkers(text: string): string {
  return text.replace(MARKERS, '').replace(/\s+([.,;:!?。，；：！？])/g, '$1').trim();
}

/** Text as one line of at most `max` code points, cut on a word with an ellipsis. */
function clip(text: string, max: number): string {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  if (chars.length <= max) return chars.join('');
  let cut = chars.slice(0, max - 1).join('');
  const space = cut.lastIndexOf(' ');
  if (space > cut.length * 0.6) cut = cut.slice(0, space);
  return `${cut.replace(/[\s,;:，；：、]+$/, '')}…`;
}

/** Ends a question with a question mark when it has no closing punctuation, in the question's own script. */
function asQuestion(question: string): string {
  const line = question.replace(/\s+/g, ' ').trim();
  if (/[.!?。！？…]$/.test(line)) return line;
  return /[㐀-鿿]/.test(line) ? `${line}？` : `${line}?`;
}

/** What a description keeps for the Ree's coverage after the question and answer, when it has one. */
const COVERAGE_ROOM = 40;

/**
 * A Ree page's meta description once it has an answered question: the
 * first question and the opening of its answer, then the Ree's own
 * description of what it covers, about `META_DESCRIPTION_CHARS` in all.
 * The question keeps at most half; the answer what is left after
 * `COVERAGE_ROOM` for the coverage (at least its first words); the
 * coverage fills the rest, and is left out when too little would remain
 * to say anything.
 */
export function reeExampleDescription(example: Pick<ReeExample, 'question' | 'summary'>, coverage: string, max = META_DESCRIPTION_CHARS): string {
  const question = clip(asQuestion(example.question), Math.floor(max / 2));
  const answer = withoutMarkers(example.summary);
  const about = coverage.replace(/\s+/g, ' ').trim();
  const first = sentencesOf(answer)[0] ?? answer;
  const room = max - Array.from(question).length - 1 - (about ? Math.min(COVERAGE_ROOM, Array.from(about).length) + 1 : 0);
  const lead = joined(question, clip(first, Math.max(room, 24)));
  const left = max - Array.from(lead).length - 1;
  if (!about || left < 20) return clip(lead, max);
  return joined(lead, clip(about, left));
}
