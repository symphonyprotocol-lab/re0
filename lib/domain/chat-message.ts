/**
 * The shape of a conversation message on the wire and in `useChat`: AI SDK
 * UI messages. One question gets one assistant message holding every asked
 * Ree's reply side by side (rebuild-proposal.md 5, 7 "问答生成"): a `ree`
 * data part as each Ree starts, its text in a text part tagged with the Ree
 * in `providerMetadata`, and one `outcome` data part when it is done --
 * charged or not, why there was no answer, the citation snapshots. Data
 * parts carry `reeId` and use it as their id, so a Ree's parts are found and
 * updated in place while several stream at once.
 */
import type { UIMessage } from 'ai';
import type { CitationSnapshot } from '@/lib/domain/answer';

export interface ReeOutcome {
  reeId: string;
  messageId: string | null;
  noAnswer: boolean;
  reason: 'no_sources' | 'out_of_scope' | null;
  cost: number;
  citations: CitationSnapshot[];
  /** The generation model that answered, for the console's "next question uses it" check. */
  model: string | null;
  /** The answer broke off; whatever was held went back. */
  failed: boolean;
  /** The asker's vote on this answer, when there is one. */
  vote?: 'up' | 'down' | null;
}

/** "This Ree is answering": sent first, so each asked Ree has its bubble before any text. */
export interface ReeStart {
  reeId: string;
}

/** A public Ree offered under a question nobody could answer ("这些公开 Ree 可能知道"). */
export interface SuggestedRee {
  id: string;
  slug: string;
  name: string;
  description: string;
  avatarBlob: string | null;
  color: string;
  role: string;
  /** What one answer costs this asker: base fee plus the owner's query fee. */
  price: number;
}

export interface Suggestions {
  rees: SuggestedRee[];
}

export type ReeUIMessage = UIMessage<never, { outcome: ReeOutcome; ree: ReeStart; suggestions: Suggestions }>;

/** The tag on a Ree's text part (`providerMetadata.re0.reeId`). */
export const TEXT_META_KEY = 're0';

export function textPartId(reeId: string): string {
  return `answer-${reeId}`;
}

export interface ReeReply {
  reeId: string;
  text: string;
  outcome: ReeOutcome | null;
}

/** An assistant message's replies, one per Ree, in the order the Rees started. */
export function repliesOf(message: ReeUIMessage): ReeReply[] {
  const order: string[] = [];
  const replies = new Map<string, ReeReply>();
  const at = (reeId: string) => {
    let reply = replies.get(reeId);
    if (!reply) {
      reply = { reeId, text: '', outcome: null };
      replies.set(reeId, reply);
      order.push(reeId);
    }
    return reply;
  };
  for (const part of message.parts) {
    if (part.type === 'data-ree') at(part.data.reeId);
    else if (part.type === 'data-outcome') at(part.data.reeId).outcome = part.data;
    else if (part.type === 'text') {
      const reeId = (part.providerMetadata?.[TEXT_META_KEY] as { reeId?: string } | undefined)?.reeId;
      if (reeId) at(reeId).text += part.text;
    }
  }
  return order.map((reeId) => replies.get(reeId)!);
}

export function suggestionsOf(message: ReeUIMessage): SuggestedRee[] {
  for (const part of message.parts) if (part.type === 'data-suggestions') return part.data.rees;
  return [];
}

/** What the API answers instead of a stream when the balance cannot cover the hold. */
export interface InsufficientCreditsBody {
  error: 'insufficient_credits';
  balance: number;
  needed: number;
}
