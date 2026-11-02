/** Route helpers for conversations: the domain's refusals as `{error}` responses, and the caller's address for rate limits. */
import { fail } from '@/lib/http/respond';
import { ConversationError } from '@/lib/services/conversations';

export function conversationFailure(error: unknown) {
  if (error instanceof ConversationError) return fail(error.code, error.status);
  throw error;
}

/** The client address Vercel puts first in `x-forwarded-for`; null when there is none (local runs). */
export function clientIp(headers: Headers): string | null {
  const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || headers.get('x-real-ip') || null;
}
