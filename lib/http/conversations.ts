/** Route helpers for conversations: the domain's refusals as `{error}` responses, and the caller's address for rate limits. */
import { fail } from '@/lib/http/respond';
import { ConversationError } from '@/lib/services/conversations';

export function conversationFailure(error: unknown) {
  if (error instanceof ConversationError) return fail(error.code, error.status);
  throw error;
}

/**
 * The client address: `x-real-ip`, which Vercel sets itself, before the
 * first `x-forwarded-for` entry, which a client can write when a proxy only
 * appends to it. Null when there is neither (local runs).
 */
export function clientIp(headers: Headers): string | null {
  return headers.get('x-real-ip')?.trim() || headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;
}
