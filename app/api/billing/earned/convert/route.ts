import type { NextRequest } from 'next/server';
import { body, fail, json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import type { ConvertRefusal } from '@/lib/domain/earned';
import { convertEarned } from '@/lib/services/earned';

const STATUS: Record<ConvertRefusal, number> = {
  convert_disabled: 403,
  invalid_amount: 400,
  below_minimum: 400,
  rate_changed: 409,
  insufficient_earned: 409,
};

/**
 * `POST /api/billing/earned/convert` `{ credits, rateBp }`
 * (docs/design/earned-credits.md): turns that many earned credits into Pack
 * credits at the rate the dialog showed. Not undoable.
 */
export async function POST(request: NextRequest) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const result = await convertEarned(user.id, await body(request));
  if (!result.ok) return fail(result.error, STATUS[result.error], result.available !== undefined ? { available: result.available } : undefined);
  return json({ converted: result.converted, received: result.received, offset: result.offset });
}
