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
  /** The answer (`post_answer`). */
  id: string;
  /** The post it answers (`/p/[postId]`). */
  postId: string;
  /** Who asked, as the page says it: a visitor or a signed-in user. */
  asker: 'visitor' | 'user';
  /** The author's name, for a public post they did not make anonymous; null otherwise ("一位用户"). */
  author: string | null;
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
 * Patterns run on a folded copy, one character for one so positions still
 * line up with the text kept (full NFKC would also turn the reader's ，。
 * into ,. -- so only what matters here is folded):
 * - full-width digits, letters, ＠ and separators (１３８…, me＠qq．com);
 * - every way of writing a digit as one character: 〇零一…九, the formal
 *   壹…玖, 两 and 幺, circled ①…⑨ -- so 138零零138零零零 and 壹叁捌… read as
 *   the numbers they are;
 * - list-style separators (，、～) as , and ~, dashes (—–) as -, and the
 *   full-width ｜＋＊＃：；（） as their ASCII forms.
 * Digits written as words in ordinary prose rarely run to seven in a row;
 * the long-number rule below needs seven.
 */
const DIGIT_CHARS: Record<string, string> = {};
for (const [digit, chars] of Object.entries({ 0: '〇零⓪', 1: '一壹幺①', 2: '二贰两②', 3: '三叁③', 4: '四肆④', 5: '五伍⑤', 6: '六陆⑥', 7: '七柒⑦', 8: '八捌⑧', 9: '九玖⑨' })) {
  for (const char of chars) DIGIT_CHARS[char] = digit;
}
const OTHER_CHARS: Record<string, string> = { '　': ' ', '，': ',', '、': ',', '～': '~', '—': '-', '–': '-', '（': '(', '）': ')' };
const FOLD = /[０-９Ａ-Ｚａ-ｚ＠．－＿／｜＋＊＃：；]/;
function fold(text: string): string {
  let out = '';
  for (const char of text) {
    out += DIGIT_CHARS[char] ?? OTHER_CHARS[char] ?? (FOLD.test(char) ? String.fromCharCode(char.charCodeAt(0) - 0xfee0) : char);
  }
  return out;
}

/*
 * E-mail, with or without a top-level domain (me@qq), spaced out
 * (me @ qq . com -- only with a domain ending, so "Ask @Brazil Guide" stays),
 * and spelled out: me (at) gmail (dot) com, me（at）qq（dot）com,
 * me at qq dot com, me at gmail.com, me艾特qq点com, me圈qq点com.
 */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*/g;
const SPACED_EMAIL = /[A-Za-z0-9._%+-]+\s*@\s*[A-Za-z0-9-]+(?:\s*\.\s*[A-Za-z0-9-]+)*\s*\.\s*[a-z]{2,6}\b/gi;
/* "at" before a domain with its ending: me at gmail.com. The ending is lower case, so "look at it.Then" stays. */
const AT_DOMAIN = /\b[A-Za-z0-9._%+-]+\s+[Aa][Tt]\s+[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,6}\b/g;
/* Bracketed: (at) [at] {at}, and the same for dot. */
const SPELLED_EMAIL = /[A-Za-z0-9._%+-]+\s*[([{]\s*at\s*[)\]}]\s*[A-Za-z0-9-]+(?:\s*[([{]\s*dot\s*[)\]}]\s*[A-Za-z0-9-]+)+/gi;
/* Words: me at qq dot com -- the domain in lower case, so "work at Google dot com" style prose is a name, not an address. */
const WORDED_EMAIL = /\b[A-Za-z0-9._%+-]+\s+[Aa][Tt]\s+[a-z0-9-]+(?:\s+[Dd][Oo][Tt]\s+[a-z]{2,6})+\b/g;
/* # for @ (me＃qq．com), AT glued in (meＡＴqq.com), and letters spaced out (m e @ q q . c o m). */
const HASH_EMAIL = /[A-Za-z0-9._%+-]+#[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[a-z]{2,6}\b/g;
const GLUED_AT_EMAIL = /\b[a-z0-9._%+-]+AT[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,6}\b/g;
const SPACED_LETTERS_EMAIL = /(?<![A-Za-z0-9])(?:[A-Za-z0-9] ){2,}[A-Za-z0-9]? ?@ ?(?:[A-Za-z0-9] ?){2,}\. ?(?:[a-z] ?){1,5}[a-z](?![A-Za-z])/g;
/*
 * "at" in ordinary English -- look at, work at, meet at -- before something
 * that only looks like a domain: kept. The word before "at" decides.
 */
const AT_VERBS = new Set(['look', 'looking', 'looked', 'work', 'works', 'working', 'worked', 'meet', 'met', 'stay', 'stayed', 'staying', 'arrive', 'arrived', 'live', 'lives', 'lived', 'based', 'hosted', 'available', 'find', 'found', 'sign', 'signed', 'log', 'logged', 'click', 'point', 'aim', 'go', 'went', 'is', 'are', 'was', 'were', 'be', 'am', 'him', 'her', 'them', 'it', 'us']);
const atInProse = (match: string): boolean => AT_VERBS.has((match.trim().split(/\s+/)[0] ?? '').toLowerCase());
/*
 * A QQ or WeChat id after the word that names it: QQ 654321, 微信号：linmei,
 * wx lin_mei_88. Six-digit QQ numbers and all-letter WeChat ids cannot be
 * told from ordinary words on their own, so only after a hint: with a colon
 * any id of 5 or more; without one it must have a digit or an underscore
 * ("WeChat official account" stays).
 */
const ID_HINT = '(?:QQ|qq|Qq|Q号|扣扣|微信号?|威信|V信|v信|wx|WX|vx|VX|wechat|WeChat|Wechat|weixin)';
const HINTED_ID_AFTER_COLON = new RegExp(`(?<=${ID_HINT}\\s*号?\\s*[:：]\\s*)[A-Za-z0-9][-_A-Za-z0-9]{4,19}`, 'g');
const HINTED_ID = new RegExp(`(?<=${ID_HINT}\\s*号?\\s*)(?=[-_A-Za-z]*[0-9_])[A-Za-z0-9][-_A-Za-z0-9]{4,19}`, 'g');
const CHINESE_EMAIL = /[A-Za-z0-9._%+-]+\s*(?:艾特|圈a|圈)\s*[A-Za-z0-9-]+(?:\s*(?:点|dot)\s*[A-Za-z]{2,6})+/gi;
/* Mainland identity card numbers: 17 digits and a check character. Letters may touch it (身份证号E…). */
const ID_CARD = /(?<![0-9])[1-9][0-9]{5}(?:18|19|20)[0-9]{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12][0-9]|3[01])[0-9]{3}[0-9Xx](?![0-9])/g;
/*
 * Any run of 7 or more digits, optionally with a leading + and, between
 * them, up to three separators -- spaces, dots, dashes, slashes,
 * underscores, middle dots, brackets, | + * # : ; → …, and the list-style
 * , ~ -- or any run of spaces: phone, card, account, QQ and passport
 * numbers. Only a digit next to it stops it, so wx13800138000 and
 * QQ12345678 are caught.
 */
const LONG_NUMBER = /(?<![0-9])\+?(?:[0-9](?:[\s().\-/_·,~|+*#:;→…丨=^%&\u200b-\u200d\u2060\ufeff]{0,3}|\s{4,})){6,}[0-9](?![0-9])/g;
/* A date written with separators is not personal: 2026-11-18, 2026/11/18. */
const DATE = /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/;
/* Thousands are not personal either: 1,200,000. */
const THOUSANDS = /^\d{1,3}(?:,\d{3})+$/;
/*
 * Numbers in a list or a range -- 1200、1500、1800 or 1000~2000 -- are kept
 * unless together they spell something personal:
 * - a mainland mobile, with or without 86 (138，0013，8000, +86 138,0013,8000);
 * - a mainland landline with its area code (021，6123，4567);
 * - a card: 15 to 19 digits in groups of four (6222,0212,3456,7890) --
 *   unless every group ends in 0, which is a list of round prices;
 * - an identity number split up (110105,19491231,002X: 17 digits).
 * Prices and counts in lists are common in questions; review is the
 * second layer for what still gets through.
 */
const LIST_SEPARATED = /[,~/:]/;
const MOBILE = /^(?:86)?1[3-9]\d{9}$/;
/* An ISBN (978-7-111-12345-6) and an order number that starts with its date (202611190001) are not about a person. */
/* The first 17 digits of an identity number, split: region, birth date, sequence. */
const ID_BODY = /^\d{6}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}$/;
const ISBN = /^97[89]\d{10}$/;
const DATED_ORDER = /^20\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{4,}$/;
const LANDLINE = /^0\d{9,11}$/;
function cardLike(match: string, digits: string): boolean {
  if (digits.length < 15 || digits.length > 19) return false;
  const groups = match.split(/[^0-9]+/).filter(Boolean);
  if (groups.length < 3 || groups.slice(0, -1).some((group) => group.length !== 4)) return digits.length === 17;
  /* Only the four-digit groups: a numeral just after the list (…4000 四档) folds into a short last group. */
  return !groups.filter((group) => group.length === 4).every((group) => group.endsWith('0'));
}
/*
 * Whether a long digit run is ordinary, in this order:
 * 1. short, a date or thousands: ordinary;
 * 2. a mobile, a landline, a card or the body of an identity number: personal,
 *    however it is separated;
 * 3. an ISBN, or an order number starting with its date: ordinary;
 * 4. four or more groups of at most three digits -- scores 98:95:100:87,
 *    tiers 99/199/299/399, sizes 36 37 … 42: ordinary;
 * 5. groups of three or more digits all ending in 0 -- 1000 2000 3000 4000:
 *    round amounts, ordinary;
 * 6. a list or a range (, ~ / :): ordinary;
 * 7. anything else -- one long run, or groups like 138 1234 5678: personal.
 */
function ordinaryNumber(match: string): boolean {
  const digits = match.replace(/[^0-9]/g, '');
  const trimmed = match.trim();
  if (digits.length < 7 || DATE.test(trimmed) || THOUSANDS.test(trimmed)) return true;
  if (MOBILE.test(digits) || LANDLINE.test(digits) || cardLike(trimmed, digits) || ID_BODY.test(digits)) return false;
  const groups = trimmed.split(/[^0-9]+/).filter(Boolean);
  if (ISBN.test(digits) || (groups.length === 1 && DATED_ORDER.test(digits))) return true;
  if (groups.length >= 4 && groups.every((group) => group.length <= 3)) return true;
  if (groups.length >= 2 && groups.every((group) => group.length >= 3 && group.endsWith('0'))) return true;
  return LIST_SEPARATED.test(match);
}
const URL = /\b(?:https?:\/\/|www\.)[^\s<>"'）)】\]]+/gi;

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
 * numbers, also in full-width, Chinese, formal or circled numerals and
 * mixed, whatever separates or precedes them) and, in the question only,
 * links. The answer keeps its
 * links: they come from the Ree's own sources.
 */
export function redact(text: string, lang: 'zh' | 'en', options: { links?: boolean } = {}): string {
  const mark = REDACTED[lang];
  let pair: [string, string] = [text, fold(text)];
  pair = cut(...pair, EMAIL, mark);
  pair = cut(...pair, SPELLED_EMAIL, mark);
  pair = cut(...pair, WORDED_EMAIL, mark, atInProse);
  pair = cut(...pair, SPACED_EMAIL, mark);
  pair = cut(...pair, HASH_EMAIL, mark);
  pair = cut(...pair, GLUED_AT_EMAIL, mark);
  pair = cut(...pair, SPACED_LETTERS_EMAIL, mark);
  pair = cut(...pair, AT_DOMAIN, mark, atInProse);
  pair = cut(...pair, CHINESE_EMAIL, mark);
  pair = cut(...pair, ID_CARD, mark);
  if (options.links ?? true) pair = cut(...pair, URL, mark);
  pair = cut(...pair, LONG_NUMBER, mark, ordinaryNumber);
  pair = cut(...pair, HINTED_ID_AFTER_COLON, mark);
  pair = cut(...pair, HINTED_ID, mark);
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


/**
 * The review's output budget: the JSON verdict is about 20 tokens, but a
 * model that thinks first spends its reasoning tokens from the same budget.
 */
export const MODERATION_OUTPUT_TOKENS = 1_000;
/** Calls per check before it counts as a failed one: a reply cut off or without a verdict is asked once more. */
export const MODERATION_TRIES = 2;

export const MODERATION_SCHEMA = z.object({
  publish: z.boolean(),
  reason: z.string(),
});

/* What makes text unfit to publish, shared by both reviews. */
const REFUSE_WHEN =
  'any contact detail at all, even without a name -- a phone number, WeChat, QQ, Telegram or other messaging ID, e-mail address, social media handle or home address, however it is written (spelled out, in Chinese numerals, split by spaces or symbols); personal details that could identify a private person (names together with address, health, finances or workplace); harassment, threats or insults; sexual content; hate; instructions for violence or crime; spam or advertising; or text that is not a question or request at all (gibberish, a test message).';
/*
 * The real model refused about one ordinary question in 25 as "too vague"
 * (2026-11-19): only text that is no question at all is refused on that ground.
 */
const GENUINE = 'A short, vague or casual question, or one that leaves out context, is still a genuine question: allow it.';

/** A question with its answer, before it is shown on a Ree's page (public Q&A, a post's summary). */
export const MODERATION_INSTRUCTIONS = [
  'You review a question and answer before it is shown publicly on a knowledge assistant\'s page. You never answer the question.',
  'Allow it (publish: true) when it is an ordinary question about the assistant\'s subject and its answer.',
  `Refuse it (publish: false) when either part contains: ${REFUSE_WHEN}`,
  GENUINE,
  'Text already replaced by [已隐去] or [removed] is fine.',
  'Reply with JSON only: {"publish": boolean, "reason": "a few words"}.',
].join('\n');

/**
 * A question alone, before it is posted publicly for Rees to answer: there
 * is no answer yet, and that is never a reason to refuse (a real model did,
 * given an empty answer slot, 2026-11-19).
 */
export const MODERATION_QUESTION_INSTRUCTIONS = [
  'You review a question before it is posted publicly for knowledge assistants to answer. You never answer it, and it has no answer yet: judge the question alone.',
  'Allow it (publish: true) when it is an ordinary, genuine question on any subject.',
  `Refuse it (publish: false) when it contains: ${REFUSE_WHEN}`,
  GENUINE,
  'Text already replaced by [已隐去] or [removed] is fine.',
  'Reply with JSON only: {"publish": boolean, "reason": "a few words"}.',
].join('\n');

/** The review's prompt: the question, and its answer unless there is none (a post's question alone). */
export function moderationPrompt(question: string, answer: string): string {
  return answer ? `Question:\n${question}\n\nAnswer:\n${answer}` : `Question:\n${question}`;
}

/**
 * The review's verdict from the model's text, leniently: a model without
 * structured output may wrap the JSON in prose or a code fence. Null when no
 * JSON object with a boolean `publish` is in it (a truncated reply).
 */
export function parseModeration(text: string): { publish: boolean; reason: string } | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = MODERATION_SCHEMA.partial({ reason: true }).safeParse(JSON.parse(text.slice(start, end + 1)));
    return parsed.success ? { publish: parsed.data.publish, reason: parsed.data.reason ?? '' } : null;
  } catch {
    return null;
  }
}
