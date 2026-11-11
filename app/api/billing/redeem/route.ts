import type { NextRequest } from 'next/server';
import { clientIp } from '@/lib/http/conversations';
import { body, fail, json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { redeemCode, type RedeemRefusal } from '@/lib/services/redeem';

const STATUS: Record<RedeemRefusal, number> = {
  code_not_found: 400,
  code_not_started: 400,
  code_expired: 400,
  code_disabled: 400,
  code_exhausted: 409,
  already_redeemed: 409,
  plan_subscription_renewing: 409,
  plan_renewal_pending: 409,
  too_many_attempts: 429,
};

/**
 * `POST /api/billing/redeem` `{ code, requestId }` (docs/design/redeem-codes.md 7):
 * a Pack's credits, or a Plan that starts now or after what the user already
 * holds. `requestId` (a UUID per submission) makes a retry return the first
 * answer instead of redeeming twice.
 */
export async function POST(request: NextRequest) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const result = await redeemCode(user.id, await body(request), {
    ip: clientIp(request.headers),
    userAgent: request.headers.get('user-agent'),
  });
  if (!result.ok) {
    const extra: Record<string, unknown> = {};
    if (result.retryAfter !== undefined) extra.retryAfter = result.retryAfter;
    if (result.startsAt !== undefined) extra.startsAt = result.startsAt;
    const response = fail(result.error, STATUS[result.error], extra);
    if (result.retryAfter !== undefined) response.headers.set('retry-after', String(result.retryAfter));
    return response;
  }
  const { ok: _ok, ...outcome } = result;
  return json(outcome);
}
