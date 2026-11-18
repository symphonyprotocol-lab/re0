/**
 * Public Q&A (the Ree page's 问答 stream): a single question and its
 * answer, published only when the asker ticked "公开" and the snapshot
 * passed redaction and a moderation check. What the browser and the
 * server agree on; the server side is lib/services/public-qa.ts.
 */
import { z } from 'zod';
import type { CitationSnapshot } from '@/lib/domain/answer';

export const PUBLIC_QA_STATUSES = ['pending', 'published', 'hidden', 'rejected'] as const;
export type PublicQaStatus = (typeof PUBLIC_QA_STATUSES)[number];
export const PUBLIC_QA_SOURCES = ['anonymous', 'user', 'share'] as const;
export type PublicQaSource = (typeof PUBLIC_QA_SOURCES)[number];
export const PUBLIC_QA_HIDERS = ['owner', 'admin', 'reports'] as const;
export type PublicQaHider = (typeof PUBLIC_QA_HIDERS)[number];

/** One page of the Ree page's stream. */
export const PUBLIC_QA_PAGE_SIZE = 10;
/** How many the share page shows ("大家问过的"). */
export const PUBLIC_QA_PICKS = 2;
/** An answer longer than this is cut on the server; "展开全文" fetches the whole one. */
export const PUBLIC_QA_PREVIEW_CHARS = 300;
/** The longest answer a snapshot keeps. */
export const PUBLIC_QA_ANSWER_MAX_CHARS = 20_000;
/** Distinct reporters that hide an answer until an administrator looks at it. */
export const PUBLIC_QA_REPORT_THRESHOLD = 3;
/** Moderation tries before a snapshot is left unpublished for good. */
export const PUBLIC_QA_MODERATION_ATTEMPTS = 3;
/** The anchor of the Ree page's question box (`/r/[slug]#ask`). */
export const PUBLIC_QA_ASK_ANCHOR = 'ask';

/** A published question and answer as a page shows it. */
export interface PublicQa {
  id: string;
  /** Who asked, as the page says it: a visitor or a signed-in user, never a name. */
  asker: 'visitor' | 'user';
  question: string;
  answer: string;
  /** The answer was cut at `PUBLIC_QA_PREVIEW_CHARS`; `GET …/public-qa/[qaId]` has the whole. */
  truncated: boolean;
  citations: CitationSnapshot[];
  helpful: number;
  /** The viewer marked it helpful. */
  voted: boolean;
  pinned: boolean;
  publishedAt: string;
}

export interface PublicQaPage {
  items: PublicQa[];
  total: number;
  next: string | null;
}

/* ---------------------------------------------------------------- redaction */

const REDACTED = { zh: '[已隐去]', en: '[removed]' } as const;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/* Mainland identity card numbers: 17 digits and a check character. */
const ID_CARD = /(?<![0-9])[1-9][0-9]{5}(?:18|19|20)[0-9]{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12][0-9]|3[01])[0-9]{3}[0-9Xx](?![0-9])/g;
/* Any run of 7 or more digits, optionally with a leading + and spaces, dots, dashes or brackets between them: phone, card and account numbers. */
const LONG_NUMBER = /(?<![0-9A-Za-z])\+?(?:[0-9][\s().-]{0,2}){6,}[0-9](?![0-9A-Za-z])/g;
const URL = /\b(?:https?:\/\/|www\.)[^\s<>"'）)】\]]+/gi;
/* A four-digit year and plain small numbers are not personal: the long-number rule needs 7 digits. */

/**
 * What an asker typed, with what could identify a person replaced: e-mail
 * addresses, identity card numbers, long digit runs (phones, cards,
 * accounts) and, in the question only, links. The answer keeps its links:
 * they come from the Ree's own sources.
 */
export function redact(text: string, lang: 'zh' | 'en', options: { links?: boolean } = {}): string {
  const mark = REDACTED[lang];
  let out = text.replace(EMAIL, mark).replace(ID_CARD, mark);
  if (options.links ?? true) out = out.replace(URL, mark);
  out = out.replace(LONG_NUMBER, (match) => (match.replace(/[^0-9]/g, '').length >= 7 ? mark : match));
  return out;
}

/** The answer as a page first shows it: whole, or cut on a word or character boundary with `truncated`. */
export function previewOf(answer: string, max = PUBLIC_QA_PREVIEW_CHARS): { answer: string; truncated: boolean } {
  if (answer.length <= max) return { answer, truncated: false };
  let cut = answer.slice(0, max);
  const space = cut.lastIndexOf(' ');
  if (space > max * 0.7) cut = cut.slice(0, space);
  /* Never end inside a citation marker such as "[1" or "[1][": the page would show it as text. */
  const open = cut.lastIndexOf('[');
  if (open > cut.lastIndexOf(']')) cut = cut.slice(0, open);
  return { answer: `${cut.trimEnd()}…`, truncated: true };
}


/* --------------------------------------------------------------- moderation */


export const MODERATION_SCHEMA = z.object({
  publish: z.boolean(),
  reason: z.string(),
});

export const MODERATION_INSTRUCTIONS = [
  'You review a question and answer before it is shown publicly on a knowledge assistant\'s page. You never answer the question.',
  'Allow it (publish: true) when it is an ordinary question about the assistant\'s subject and its answer.',
  'Refuse it (publish: false) when either part contains: personal details that could identify a private person (names together with contact, address, health, finances or workplace); harassment, threats or insults; sexual content; hate; instructions for violence or crime; spam or advertising; or text that is not a genuine question.',
  'Text already replaced by [已隐去] or [removed] is fine.',
  'Reply with JSON: {"publish": boolean, "reason": "a few words"}.',
].join('\n');

export function moderationPrompt(question: string, answer: string): string {
  return `Question:\n${question}\n\nAnswer:\n${answer}`;
}
