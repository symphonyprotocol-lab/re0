/**
 * The one code a P3 form action puts in the query string when a use case
 * refuses (agent-first-proposal.md 6.5-6.9): every refusal class carries a
 * `code`, and the page words it. Anything else is logged and reads as
 * `unavailable`, so an outage never passes for a rule.
 */
import { AppError } from '@/contracts/errors';
import { ChannelRefused } from '@/lib/domain/channel';
import { ChannelCommerceRefused } from '@/lib/domain/channel-commerce';
import { CommentRefused } from '@/lib/domain/comment';
import { EditorialRefused } from '@/lib/domain/editorial';
import { PayoutRefused } from '@/lib/domain/payout';
import { QuestionRefused } from '@/lib/application/questions';

export function refusalCode(error: unknown, verb: string): string {
  if (
    error instanceof EditorialRefused ||
    error instanceof ChannelCommerceRefused ||
    error instanceof ChannelRefused ||
    error instanceof CommentRefused ||
    error instanceof QuestionRefused ||
    error instanceof PayoutRefused
  ) {
    return error.code;
  }
  if (error instanceof AppError) return error.code;
  console.error(`${verb} failed: ${error instanceof Error ? error.message : 'unknown'}`);
  return 'unavailable';
}
