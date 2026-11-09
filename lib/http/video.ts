import { InsufficientCredits } from '@/lib/domain/credits';
import { fail } from '@/lib/http/respond';
import { VideoError } from '@/lib/services/video';

/** The video routes' refusals as `{ error }` responses; anything else is rethrown. */
export function videoFailure(error: unknown) {
  if (error instanceof VideoError) return fail(error.code, error.status, error.extra);
  if (error instanceof InsufficientCredits) return fail('insufficient_credits', 402, { needed: error.needed, balance: error.available });
  throw error;
}
