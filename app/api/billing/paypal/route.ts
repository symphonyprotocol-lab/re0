import type { NextRequest } from 'next/server';
import { body, json } from '@/lib/http/respond';
import { refusal } from '@/lib/http/payouts';
import { apiUser } from '@/lib/http/session';
import { setPaypalEmail } from '@/lib/services/payouts';

/**
 * Sets the PayPal personal account's e-mail (`{ email }`, ≤ 254), only with
 * verified identity. A change starts seven days without payouts; the answer
 * carries `holdUntil`.
 */
export async function PUT(request: NextRequest) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  try {
    return json(await setPaypalEmail(user.id, (await body(request)).email));
  } catch (error) {
    return refusal(error);
  }
}
