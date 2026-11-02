/**
 * The shape of a conversation message on the wire and in `useChat`: AI SDK
 * UI messages whose Ree answers carry one `outcome` data part -- charged or
 * not, why there was no answer, and the citation snapshots.
 */
import type { UIMessage } from 'ai';
import type { CitationSnapshot } from '@/lib/domain/answer';

export interface ReeOutcome {
  messageId: string | null;
  noAnswer: boolean;
  reason: 'no_sources' | 'out_of_scope' | null;
  cost: number;
  citations: CitationSnapshot[];
  /** The generation model that answered, for the console's "next question uses it" check. */
  model: string | null;
  /** The answer broke off; whatever was held went back. */
  failed: boolean;
}

export type ReeUIMessage = UIMessage<never, { outcome: ReeOutcome }>;

/** What the API answers instead of a stream when the balance cannot cover the hold. */
export interface InsufficientCreditsBody {
  error: 'insufficient_credits';
  balance: number;
  needed: number;
}
