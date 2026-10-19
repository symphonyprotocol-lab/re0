/**
 * What the keyword leg's chunks hold of the question, as pure functions.
 * lib/domain/routing.ts `KeywordEvidence` is the result; this is how it is
 * read off the chunk bodies.
 *
 * The question's content words are its routing tokens (stopwords gone); a
 * chunk covers a word when the chunk's own tokens contain it, both sides
 * reduced by the same plural-stripping stem so "links" meets "link". A
 * phrase is two consecutive content words of the question appearing
 * consecutively in the chunk text. Han text has no word boundaries to read
 * a phrase from and its routing tokens are n-grams, so a Han question is
 * judged on coverage alone -- which, with dozens of n-grams, it practically
 * never reaches: the band stays closed for it, on purpose, until measured.
 */
import { containsCjk } from './cjk';
import { routingTokens, searchTokens } from './profile';
import type { KeywordEvidence } from './routing';

/** The plural-stripping stem both sides are reduced to. Nothing cleverer: the tsvector leg did the real stemming. */
function stem(token: string): string {
  return token.length > 4 && token.endsWith('s') ? token.slice(0, -1) : token;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The best evidence any one of `texts` gives for `query`: the chunk covering
 * most content words, a phrase hit breaking ties. Null when the question has
 * no content words at all.
 */
export function keywordEvidenceOf(query: string, texts: readonly string[]): KeywordEvidence | null {
  const content = routingTokens(query);
  const stems = [...new Set(content.map(stem))];
  if (stems.length === 0) return null;

  const phrases: RegExp[] = [];
  for (let at = 0; at + 1 < content.length; at += 1) {
    const first = content[at]!;
    const second = content[at + 1]!;
    if (containsCjk(first) || containsCjk(second)) continue;
    phrases.push(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(first)}s?[^\\p{L}\\p{N}]+${escapeRegExp(second)}s?(?![\\p{L}\\p{N}])`, 'iu'));
  }

  let best: KeywordEvidence = { queryTerms: stems.length, coveredTerms: 0, phrase: false };
  for (const text of texts) {
    const chunkStems = new Set(searchTokens(text).map(stem));
    const coveredTerms = stems.filter((candidate) => chunkStems.has(candidate)).length;
    const phrase = phrases.some((pattern) => pattern.test(text));
    if (coveredTerms > best.coveredTerms || (coveredTerms === best.coveredTerms && phrase && !best.phrase)) {
      best = { queryTerms: stems.length, coveredTerms, phrase };
    }
  }
  return best;
}
