import type { NextRequest } from 'next/server';
import { body, json } from '@/lib/http/respond';
import { refusal } from '@/lib/http/payouts';
import { apiUser } from '@/lib/http/session';
import { payoutOverview, requestPayout } from '@/lib/services/payouts';

/** Where the user stands, what may be withdrawn, the payout in progress and the history. */
export async function GET(request: NextRequest) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  return json(await payoutOverview(user.id));
}

/**
 * Requests a payout of `{ credits }` (whole, ≥ 500,000, ≤ the earned
 * balance; all of it when left out). The credits are held at once.
 */
export async function POST(request: NextRequest) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  try {
    const payout = await requestPayout(user.id, (await body(request)).credits);
    return json({ payout }, 201);
  } catch (error) {
    return refusal(error);
  }
}
