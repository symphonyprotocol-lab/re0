/**
 * Conversations as data (rebuild-proposal.md 5, 8.2): who a question goes
 * to, what a new conversation is called, the search page's query and how its
 * results are grouped and highlighted. No database here.
 */
import {
  CONVERSATION_AUTO_TITLE,
  CONVERSATION_MAX_REES,
  CONVERSATION_PERIODS,
  CONVERSATION_TITLE_MAX,
  LIST_PAGE_SIZES,
  LOCAL_UTC_OFFSET_HOURS,
} from '@/lib/constants';

export interface Participant {
  id: string;
  name: string;
}

/**
 * The Rees a question is for (prototype chat-room.js `targets`): an explicit
 * `@name` wins and names only those; otherwise "只问这个 Ree" when it picks a
 * participant; otherwise everyone. A question with an `@` that names no
 * participant goes to nobody -- the page refuses to send it.
 */
export function questionTargets<P extends Participant>(participants: readonly P[], question: string, scope: string | null = null): P[] {
  if (question.includes('@')) {
    const text = question.toLocaleLowerCase();
    return participants.filter((ree) => text.includes(`@${ree.name.toLocaleLowerCase()}`));
  }
  const only = scope ? participants.find((ree) => ree.id === scope) : undefined;
  return only ? [only] : [...participants];
}

/** The question without its `@name`s, which address Rees and say nothing about what is asked (retrieval and the model get this). */
export function withoutMentions(question: string, names: readonly string[]): string {
  let text = question;
  for (const name of [...names].sort((a, b) => b.length - a.length)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(`@${escaped}`, 'giu'), ' ');
  }
  return text.replace(/\s+/g, ' ').trim() || question;
}

/** The `@` fragment being typed at the end of the input, for the mention menu; null when none. */
export function mentionQuery(input: string): string | null {
  const match = /@([^@\n]*)$/.exec(input);
  return match ? match[1]! : null;
}

/** Replaces the `@` fragment being typed with the chosen name. */
export function completeMention(input: string, name: string): string {
  return input.replace(/@[^@\n]*$/, `@${name} `);
}

/** Participants after a change: unique, at most five; null when the change asks for more. */
export function participantSet(ids: readonly string[]): string[] | null {
  const unique = [...new Set(ids)];
  return unique.length > CONVERSATION_MAX_REES ? null : unique;
}

export function cleanTitle(value: unknown): string | null {
  const title = String(value ?? '').replace(/\s+/g, ' ').trim();
  return title && Array.from(title).length <= CONVERSATION_TITLE_MAX ? title : null;
}

/** A conversation is named after its first question. */
export function autoTitle(question: string): string {
  return Array.from(question.replace(/\s+/g, ' ').trim()).slice(0, CONVERSATION_AUTO_TITLE).join('');
}

/* ------------------------------------------------------------ search page */

export const CONVERSATION_VIEWS = ['all', 'recent', 'pinned', 'archived', 'trash'] as const;
export const CONVERSATION_SORTS = ['new', 'old', 'title'] as const;
export type ConversationView = (typeof CONVERSATION_VIEWS)[number];
export type ConversationSort = (typeof CONVERSATION_SORTS)[number];

export interface ConversationQuery {
  q: string;
  view: ConversationView;
  ree: string | null;
  days: number | null;
  sort: ConversationSort;
  size: number;
  page: number;
}

type Params = URLSearchParams | Record<string, string | string[] | undefined>;

function read(params: Params, name: string): string {
  if (params instanceof URLSearchParams) return params.get(name) ?? '';
  const value = params[name];
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

/** `/chats` and `GET /api/chats` share these parameters (prototype conversations.js `view`). */
export function parseConversationQuery(params: Params): ConversationQuery {
  const view = read(params, 'view') as ConversationView;
  const sort = read(params, 'sort') as ConversationSort;
  const days = Number(read(params, 'days'));
  const size = Number(read(params, 'size'));
  const page = Number(read(params, 'page'));
  const ree = read(params, 'ree');
  return {
    q: read(params, 'q').trim().slice(0, 200),
    view: CONVERSATION_VIEWS.includes(view) ? view : 'all',
    ree: /^[0-9a-f-]{36}$/i.test(ree) ? ree.toLowerCase() : null,
    days: (CONVERSATION_PERIODS as readonly number[]).includes(days) ? days : null,
    sort: CONVERSATION_SORTS.includes(sort) ? sort : 'new',
    size: (LIST_PAGE_SIZES as readonly number[]).includes(size) ? size : LIST_PAGE_SIZES[0],
    page: Number.isInteger(page) && page >= 1 ? Math.min(page, 100_000) : 1,
  };
}

/** The canonical URL query of a search, defaults left out, so it can be shared and restored. */
export function conversationSearchParams(query: Partial<ConversationQuery>): URLSearchParams {
  const out = new URLSearchParams();
  if (query.q) out.set('q', query.q);
  if (query.view && query.view !== 'all') out.set('view', query.view);
  if (query.ree) out.set('ree', query.ree);
  if (query.days) out.set('days', String(query.days));
  if (query.sort && query.sort !== 'new') out.set('sort', query.sort);
  if (query.page && query.page > 1) out.set('page', String(query.page));
  if (query.size && query.size !== LIST_PAGE_SIZES[0]) out.set('size', String(query.size));
  return out;
}

/** A `from` link back to the search page, only ever to `/chats` itself. */
export function searchReturnPath(value: string | null | undefined): string {
  if (!value || (value !== '/chats' && !value.startsWith('/chats?'))) return '/chats';
  const query = conversationSearchParams(parseConversationQuery(new URLSearchParams(value.slice('/chats'.length + 1))));
  return query.size ? `/chats?${query}` : '/chats';
}

/** Whole days between two instants on the UTC+8 calendar. */
export function localDayDistance(at: Date, now: Date): number {
  const day = (time: number) => Math.floor((time + LOCAL_UTC_OFFSET_HOURS * 3_600_000) / 86_400_000);
  return day(now.getTime()) - day(at.getTime());
}

export type DateGroup = 'today' | 'yesterday' | 'week' | 'month' | 'earlier';

/** 今天 / 昨天 / 过去 7 天 / 过去 30 天 / 更早 (the sidebar folds the last two into 更早). */
export function dateGroup(at: Date, now: Date, withMonth = true): DateGroup {
  const days = localDayDistance(at, now);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return 'week';
  if (withMonth && days < 30) return 'month';
  return 'earlier';
}

export interface Segment {
  text: string;
  match: boolean;
}

/** A string cut into plain and matching runs, case-insensitively, for `<mark>`. */
export function highlight(value: string, query: string): Segment[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [{ text: value, match: false }];
  const lower = value.toLocaleLowerCase();
  const out: Segment[] = [];
  let at = 0;
  for (let index = lower.indexOf(needle); index !== -1; index = lower.indexOf(needle, at)) {
    if (index > at) out.push({ text: value.slice(at, index), match: false });
    out.push({ text: value.slice(index, index + needle.length), match: true });
    at = index + needle.length;
  }
  if (at < value.length) out.push({ text: value.slice(at), match: false });
  return out;
}

/** About 155 characters of a message around the first match (prototype `snippet`). */
export function snippet(text: string, query: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const index = query.trim() ? flat.toLocaleLowerCase().indexOf(query.trim().toLocaleLowerCase()) : 0;
  const start = Math.max(0, index - 40);
  return `${start ? '…' : ''}${flat.slice(start, start + 155)}${flat.length > start + 155 ? '…' : ''}`;
}

export const BATCH_ACTIONS = ['pin', 'unpin', 'archive', 'unarchive', 'trash', 'restore'] as const;
export type BatchAction = (typeof BATCH_ACTIONS)[number];
