/**
 * Visitor asks on the share page (2026-11-24, docs/visitor-asks.md): a Ree's
 * owner may let signed-out visitors ask it on `/s/[slug]`, and pays for
 * their answers. What the browser and the server agree on; the server side
 * is lib/services/visitor-asks.ts.
 *
 * - Off by default. On, a visitor's question goes out as a public post by
 *   "访客" naming the Ree (`source = 'visitor'`): reviewed like any post,
 *   answered by this Ree alone -- no other Ree, no AI general answer.
 * - The owner pays the base fee of each answer given (`QUERY_BASE_FEE`; the
 *   query fee of one's own Ree is waived, as when they ask it themselves),
 *   held from their balance when the visitor asks -- so a balance that
 *   cannot cover it refuses the question, never overdraws -- and given back
 *   when the question is refused or the Ree has no answer.
 * - The owner sets how many questions one visitor may ask a day
 *   (`VISITOR_ASK_PER_VISITOR`) and, optionally, how many all visitors
 *   together may ask a day (`VISITOR_ASK_PER_DAY`): the most the feature
 *   can cost them in a day. A day is the UTC date (`anonymousDay`).
 */

/** Questions one visitor may ask one Ree a day, as the owner sets it. */
export const VISITOR_ASK_PER_VISITOR = { min: 1, max: 50, default: 3 } as const;
/** The owner's optional cap on all visitors' questions to one Ree a day; empty means none of their own (the platform's still holds). */
export const VISITOR_ASK_PER_DAY = { min: 1, max: 1000 } as const;
/**
 * One client address (IPv6 by /64) may ask one Ree this many times the
 * per-visitor limit a day: an office or a household behind one address
 * still gets a few visitors' worth, while a script that makes up its
 * fingerprint and cookie on every request is held to it.
 */
export const VISITOR_ASK_NETWORK_FACTOR = 3;
/** The platform's default ceiling on visitor questions a day over all Rees (the console may change it: `visitorAsksPerDay`). */
export const VISITOR_ASK_PLATFORM_DAILY = 2_000;
/** Questions per client address per minute over all Rees, before anything else is read. */
export const VISITOR_ASK_IP_PER_MINUTE = 5;
/** How far back a visitor's own questions are listed under the box. */
export const VISITOR_ASK_LIST_DAYS = 7;
/** How many of them. */
export const VISITOR_ASK_LIST_MAX = 10;
/** The header the box's GET sends the browser fingerprint in, never the URL (lib/client/fingerprint.ts). */
export const FINGERPRINT_HEADER = 'x-re0-fp';
/** The ledger's note on an owner's hold, settlement and refund for a visitor's question (read into the reader's language, components/billing/entries.tsx). */
export const VISITOR_ASK_NOTE = 'visitor answer';

export interface VisitorAskSettings {
  enabled: boolean;
  perVisitor: number;
  /** Null: no daily total of the owner's own. */
  perDay: number | null;
}

export type VisitorAskSettingsError = 'visitor_ask_per_visitor' | 'visitor_ask_per_day';

function whole(value: unknown): number | null {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof number === 'number' && Number.isInteger(number) ? number : null;
}

/** The settings as sent by the settings form, checked; an error names the field. */
export function parseVisitorAskSettings(input: unknown): VisitorAskSettings | VisitorAskSettingsError {
  const value = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const perVisitor = whole(value.perVisitor);
  if (perVisitor === null || perVisitor < VISITOR_ASK_PER_VISITOR.min || perVisitor > VISITOR_ASK_PER_VISITOR.max) return 'visitor_ask_per_visitor';
  let perDay: number | null = null;
  if (value.perDay !== null && value.perDay !== undefined && value.perDay !== '') {
    perDay = whole(value.perDay);
    if (perDay === null || perDay < VISITOR_ASK_PER_DAY.min || perDay > VISITOR_ASK_PER_DAY.max) return 'visitor_ask_per_day';
  }
  return { enabled: value.enabled === true, perVisitor, perDay };
}

/** Which limit refused a visitor's question, as the box words it. */
export type VisitorAskRefusal =
  /** The owner turned visitor asks off, or the Ree is not public. */
  | 'closed'
  /** This visitor's questions today. */
  | 'visitor_limit'
  /** This address's, or the minute's. */
  | 'network_limit'
  /** The owner's daily total, or the platform's. */
  | 'capacity'
  /** The owner's balance cannot pay for one more answer. */
  | 'owner_credits';

/** What a visitor sees of a question they asked: under review, being answered, answered (with this Ree's answer), not answered, or refused. */
export type VisitorAskState = 'reviewing' | 'answering' | 'answered' | 'no_answer' | 'rejected';

export interface VisitorAskView {
  id: string;
  question: string;
  state: VisitorAskState;
  /** This Ree's answer once given (cut like a feed answer; the post page shows it whole). */
  answer: string | null;
  createdAt: string;
}

export interface VisitorAskStatus {
  /** The Ree (public: its share page names it too). */
  reeId: string;
  /** The owner lets visitors ask now. */
  open: boolean;
  /** Questions this visitor may still ask today (0 when closed). */
  remaining: number;
  limit: number;
  /** What stops this visitor asking now, if anything: the box says so and offers signing in. */
  blocked: VisitorAskRefusal | null;
  /** Their questions of the last few days, newest first. */
  asked: VisitorAskView[];
}
