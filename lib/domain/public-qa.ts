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

/*
 * Patterns run on a folded copy: full-width digits, letters, ＠ and the
 * separators a Chinese IME types (１３８…, me＠qq．com) become their ASCII
 * forms one character for one, so positions still line up with the text
 * kept. (Full NFKC would also turn the reader's ，。 into ,. -- so only these
 * characters are folded.)
 */
const FOLD = /[０-９Ａ-Ｚａ-ｚ＠．－＿／　]/g;
function fold(text: string): string {
  return text.replace(FOLD, (char) => (char === '　' ? ' ' : String.fromCharCode(char.charCodeAt(0) - 0xfee0)));
}

/* E-mail, with or without a top-level domain (me@qq), and spelled out: me (at) gmail (dot) com. */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*/g;
const SPELLED_EMAIL = /[A-Za-z0-9._%+-]+\s*[([]\s*at\s*[)\]]\s*[A-Za-z0-9-]+(?:\s*[([]\s*dot\s*[)\]]\s*[A-Za-z0-9-]+)+/gi;
/* Mainland identity card numbers: 17 digits and a check character. Letters may touch it (身份证号E…). */
const ID_CARD = /(?<![0-9])[1-9][0-9]{5}(?:18|19|20)[0-9]{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12][0-9]|3[01])[0-9]{3}[0-9Xx](?![0-9])/g;
/*
 * Any run of 7 or more digits, optionally with a leading + and spaces, dots,
 * dashes, slashes, underscores, middle dots or brackets between them: phone,
 * card, account, QQ and passport numbers. Only a digit next to it stops it,
 * so wx13800138000 and QQ12345678 are caught.
 */
const LONG_NUMBER = /(?<![0-9])\+?(?:[0-9][\s().\-/_·]{0,3}){6,}[0-9](?![0-9])/g;
/* The same in Chinese numerals: 一三八零零一三八零零零. */
const CHINESE_DIGITS = /[零〇一二三四五六七八九两幺](?:[\s\-·]{0,2}[零〇一二三四五六七八九两幺]){6,}/g;
/* A date written with separators is not personal: 2026-11-18, 2026/11/18. */
const DATE = /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/;
const URL = /\b(?:https?:\/\/|www\.)[^\s<>"'）)】\]]+/gi;
/* A four-digit year and plain small numbers are not personal: the long-number rule needs 7 digits. */

/** Replaces each match of `pattern` in the folded copy at the same place in `text`. */
function cut(text: string, folded: string, pattern: RegExp, mark: string, keep: (match: string) => boolean = () => false): [string, string] {
  let out = '';
  let outFolded = '';
  let at = 0;
  for (const match of folded.matchAll(pattern)) {
    const start = match.index!;
    if (keep(match[0])) continue;
    out += text.slice(at, start) + mark;
    outFolded += folded.slice(at, start) + mark;
    at = start + match[0].length;
  }
  return [out + text.slice(at), outFolded + folded.slice(at)];
}

/**
 * What an asker typed, with what could identify a person replaced: e-mail
 * addresses (also without a domain ending, or spelled out), identity card
 * numbers, long digit runs (phones, cards, accounts, QQ and passport
 * numbers, also in full-width or Chinese numerals, whatever separates or
 * precedes them) and, in the question only, links. The answer keeps its
 * links: they come from the Ree's own sources.
 */
export function redact(text: string, lang: 'zh' | 'en', options: { links?: boolean } = {}): string {
  const mark = REDACTED[lang];
  let pair: [string, string] = [text, fold(text)];
  pair = cut(...pair, EMAIL, mark);
  pair = cut(...pair, SPELLED_EMAIL, mark);
  pair = cut(...pair, ID_CARD, mark);
  if (options.links ?? true) pair = cut(...pair, URL, mark);
  pair = cut(...pair, LONG_NUMBER, mark, (match) => match.replace(/[^0-9]/g, '').length < 7 || DATE.test(match.trim()));
  pair = cut(...pair, CHINESE_DIGITS, mark);
  return pair[0];
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
  'Refuse it (publish: false) when either part contains: any contact detail at all, even without a name -- a phone number, WeChat, QQ, Telegram or other messaging ID, e-mail address, social media handle or home address, however it is written (spelled out, in Chinese numerals, split by spaces or symbols); personal details that could identify a private person (names together with address, health, finances or workplace); harassment, threats or insults; sexual content; hate; instructions for violence or crime; spam or advertising; or text that is not a genuine question.',
  'Text already replaced by [已隐去] or [removed] is fine.',
  'Reply with JSON: {"publish": boolean, "reason": "a few words"}.',
].join('\n');

export function moderationPrompt(question: string, answer: string): string {
  return `Question:\n${question}\n\nAnswer:\n${answer}`;
}
