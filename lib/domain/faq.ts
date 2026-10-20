/**
 * The widget's FAQ loop, as pure functions. requirement.md 9.4.
 *
 * Visitors ask the widget; the owner reads what was asked (widget_exchange)
 * and turns the recurring questions into FAQ entries; the entries go into
 * the next build as documents of their own, so the recurring question then
 * finds a chunk written for it. Three pieces live here: how questions are
 * grouped into one intent, what an entry looks like as a document, and how
 * such a document is told apart from the site's own pages afterwards.
 *
 * Pure TypeScript, no imports -- domain layer rules apply.
 */

export const FAQ_LIMITS = {
  questionChars: 300,
  answerChars: 2_000,
  /** Entries per library: a FAQ, not a second corpus. */
  maxEntries: 200,
  /**
   * Cosine distance under which two questions are the same intent, for
   * grouping. Paraphrases of one question embed within ~0.2 of each other
   * with text-embedding-3-small; different questions about the same page
   * sit at 0.3-0.5. Conservative on purpose: a group that merges two
   * questions costs the owner an answer that fits neither.
   */
  groupDistance: 0.22,
  /**
   * Cosine distance under which a FAQ chunk answers the question directly,
   * without a model call: the visitor asked the FAQ's own question, in
   * other words at most.
   */
  directDistance: 0.3,
} as const;

/** The fragment that marks a FAQ document's URL, so a retrieved chunk can be told apart. */
export const FAQ_URL_MARKER = '#re0-faq-';
export const FAQ_PATH_PREFIX = 'faq/';

/** One question as typed, reduced for exact-text grouping: case, spacing and punctuation gone. */
export function normaliseQuestion(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .trim();
}

export interface QuestionItem {
  id: string;
  question: string;
  /** The question's embedding when a provider is configured; absent otherwise. */
  vector?: readonly number[];
  answered: boolean;
  /** The answer the widget gave, when it gave one. */
  answer: string | null;
  /** The pages the answer cited. */
  pages: readonly { url: string; title: string }[];
}

export interface QuestionGroup {
  /** The first question seen: what the group is called. */
  question: string;
  /** Every member's question, the representative first. */
  questions: string[];
  count: number;
  unanswered: number;
  /** A recorded answer to prefill the entry with, when any member got one. */
  sampleAnswer: string | null;
  /** The cited pages, most cited first. */
  pages: { url: string; title: string; count: number }[];
}

export function cosineDistance(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let at = 0; at < n; at += 1) {
    dot += a[at]! * b[at]!;
    na += a[at]! * a[at]!;
    nb += b[at]! * b[at]!;
  }
  if (na === 0 || nb === 0) return 1;
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Group questions of one intent. Greedy, in the order given: a question
 * joins the first group whose representative is within `groupDistance`
 * (by vector) or is the same text once normalised; otherwise it opens a
 * group. Groups come back most frequent first.
 */
export function groupQuestions(
  items: readonly QuestionItem[],
  distance: number = FAQ_LIMITS.groupDistance,
): QuestionGroup[] {
  const groups: { key: string; vector?: readonly number[]; members: QuestionItem[] }[] = [];
  for (const item of items) {
    const key = normaliseQuestion(item.question);
    if (key.length === 0) continue;
    const home = groups.find(
      (group) =>
        group.key === key ||
        (group.vector !== undefined &&
          item.vector !== undefined &&
          cosineDistance(group.vector, item.vector) <= distance),
    );
    if (home) home.members.push(item);
    else groups.push({ key, vector: item.vector, members: [item] });
  }

  return groups
    .map((group) => {
      const pages = new Map<string, { url: string; title: string; count: number }>();
      for (const member of group.members) {
        for (const page of member.pages) {
          const seen = pages.get(page.url);
          if (seen) seen.count += 1;
          else pages.set(page.url, { ...page, count: 1 });
        }
      }
      return {
        question: group.members[0]!.question,
        questions: group.members.map((member) => member.question),
        count: group.members.length,
        unanswered: group.members.filter((member) => !member.answered).length,
        sampleAnswer: group.members.find((member) => member.answer)?.answer ?? null,
        pages: [...pages.values()].sort((a, b) => b.count - a.count),
      };
    })
    .sort((a, b) => b.count - a.count || b.unanswered - a.unanswered);
}

export interface FaqEntryContent {
  id: string;
  question: string;
  answer: string;
  /** The page the entry stands for; what its citation opens. */
  pageUrl: string;
}

/** The URL a FAQ document is cited by: the page, marked so retrieval knows a FAQ chunk. */
export function faqDocumentUrl(entry: Pick<FaqEntryContent, 'id' | 'pageUrl'>): string {
  const base = entry.pageUrl.split('#')[0] ?? entry.pageUrl;
  return `${base}${FAQ_URL_MARKER}${entry.id}`;
}

/** Whether a citation's URL is a FAQ document's. */
export function isFaqCitation(url: string): boolean {
  return url.includes(FAQ_URL_MARKER);
}

/** The page behind a FAQ citation, for a link that opens it. */
export function faqPageUrl(url: string): string {
  const at = url.indexOf(FAQ_URL_MARKER);
  return at === -1 ? url : url.slice(0, at);
}

/** The document a FAQ entry becomes: the question as its title, the answer as its body. */
export function faqDocument(entry: Pick<FaqEntryContent, 'question' | 'answer'>): string {
  return `# ${entry.question.trim()}\n\n${entry.answer.trim()}\n`;
}

export function faqDocumentPath(entry: Pick<FaqEntryContent, 'id'>): string {
  return `${FAQ_PATH_PREFIX}${entry.id}.md`;
}

/** The canonical text a build hashes to know whether the FAQ changed. Empty when there are no entries. */
export function faqCanonical(entries: readonly FaqEntryContent[]): string {
  return [...entries]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((entry) => `${entry.id}\t${entry.question}\t${entry.answer}\t${entry.pageUrl}`)
    .join('\n');
}

/** A FAQ answer as the sentences the widget shows, each bound to the FAQ chunk. */
export function faqSentences(text: string): string[] {
  /* Latin sentence ends need the space after them ("$3.50" is one token);
     CJK full stops end a sentence on their own. */
  return text
    .split(/(?<=[.!?])\s+|(?<=[。！？])\s*|\n+/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export type FaqRefusal = 'question' | 'answer' | 'page_url' | 'limit';

/** Validate an entry as typed. Returns the refusal, or null when it is fine. */
export function validateFaqEntry(input: { question: string; answer: string; pageUrl: string }): FaqRefusal | null {
  const question = input.question.trim();
  const answer = input.answer.trim();
  if (question.length === 0 || question.length > FAQ_LIMITS.questionChars) return 'question';
  if (answer.length === 0 || answer.length > FAQ_LIMITS.answerChars) return 'answer';
  try {
    const url = new URL(input.pageUrl.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'page_url';
  } catch {
    return 'page_url';
  }
  return null;
}
