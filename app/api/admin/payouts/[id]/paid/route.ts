import type { NextRequest } from 'next/server';
import { adminParams } from '@/lib/http/admin-params';
import { apiAdministrator } from '@/lib/http/admin';
import { adminFailure } from '@/lib/http/admin-lists';
import { body, json } from '@/lib/http/respond';
import { recordPayment } from '@/lib/services/payouts';

/**
 * "标记已打款" after the transfer in PayPal: `{ transferId, paid }`, the
 * amount in dollars with at most two decimals, more than 0 and not more than
 * requested. The difference is the fee. Final.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const params = await adminParams(context.params);
  if (params instanceof Response) return params;
  try {
    const input = await body(request);
    return json({ payout: await recordPayment(administrator.id, params.id, { transferId: input.transferId, paid: input.paid }) });
  } catch (error) {
    return adminFailure(error);
  }
}
