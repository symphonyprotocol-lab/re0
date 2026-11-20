/**
 * AI 通用回答 (design draft 1, section 8): what the model is told and what
 * is kept of what it writes. A general assistant, never a Ree or a person,
 * with no sources; the server side is lib/services/ai-answers.ts.
 */
import { redact } from '@/lib/domain/public-qa';

/** What the model knows of the thread a follow-up belongs to: never a Ree's answer, only questions and the asker's own earlier AI answer. */
export interface AiAnswerThread {
  /** The post's question (and detail), for a follow-up. */
  postQuestion?: string | null;
  /** The asker's earlier AI answer under the post, when there is one. */
  earlierAnswer?: string | null;
  /** Earlier follow-ups' questions, oldest first. */
  earlierQuestions?: readonly string[];
}

/** At most this many earlier follow-ups go along: the recent part of a long thread is what matters. */
const THREAD_QUESTIONS = 6;
const THREAD_ANSWER_CHARS = 2_000;

/** The system prompt: the rules of section 8, in English (the model answers in the question's language). */
export function aiAnswerInstructions(lang: 'zh' | 'en'): string {
  return [
    'You are RE0\'s general assistant. Nobody on the site had knowledge on this question, so you give the asker a general answer from common knowledge.',
    'Rules:',
    '- You are not a Ree and not a person. Never claim to be a Ree, an expert, the site\'s creators or anyone in particular.',
    '- Give no sources. Do not invent links, book titles, studies, statistics or data sources, and do not write citation markers such as [1].',
    '- When you are not sure, say so plainly instead of guessing.',
    `- Answer in the language of the question (${lang === 'zh' ? 'Chinese' : 'English'} unless the question is in another one).`,
    `- Be concise: lead with the conclusion, then the reasons; at most about ${lang === 'zh' ? '400 Chinese characters' : '250 words'}. Use short paragraphs or a short list; no headings.`,
    '- For medical, legal, financial or psychological questions, end with one sentence saying this is for reference only and to consult a qualified professional.',
    '- Never give concrete steps for anything illegal or dangerous.',
  ].join('\n');
}

/** The user message: the question and its detail, and for a follow-up the thread so far (questions, and the asker's earlier AI answer). */
export function aiAnswerPrompt(question: string, detail: string, thread: AiAnswerThread = {}): string {
  const parts: string[] = [];
  if (thread.postQuestion) parts.push(`The original question:\n${thread.postQuestion}`);
  if (thread.earlierAnswer) parts.push(`Your earlier general answer to it:\n${thread.earlierAnswer.slice(0, THREAD_ANSWER_CHARS)}`);
  const earlier = (thread.earlierQuestions ?? []).slice(-THREAD_QUESTIONS);
  if (earlier.length) parts.push(`Earlier follow-up questions:\n${earlier.map((entry) => `- ${entry}`).join('\n')}`);
  const asked = [question.trim(), detail.trim()].filter(Boolean).join('\n\n');
  parts.push(thread.postQuestion ? `The follow-up question to answer now:\n${asked}` : asked);
  return parts.join('\n\n');
}

/**
 * What is kept of the model's text: citation markers it wrote anyway ("[1]",
 * "【2】", "[^3]") taken out, then phone numbers, emails, ids and links
 * hidden as a post's question is (`redact`). Empty when nothing is left.
 */
export function cleanAiAnswer(text: string, lang: 'zh' | 'en'): string {
  const stripped = text
    .replace(/ ?\[\^?\d{1,3}\](?!\()/g, '')
    .replace(/ ?【\d{1,3}】/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
  return redact(stripped, lang).trim();
}
