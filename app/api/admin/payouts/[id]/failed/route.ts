import type { NextRequest } from 'next/server';
import { adminParams } from '@/lib/http/admin-params';
import { apiAdministrator } from '@/lib/http/admin';
import { adminFailure } from '@/lib/http/admin-lists';
import { body, json } from '@/lib/http/respond';
import { failPayout } from '@/lib/services/payouts';

/** "标记失败": the transfer failed or came back; `{ reason }` 3–300 characters; the hold is released once. Final. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const params = await adminParams(context.params);
  if (params instanceof Response) return params;
  try {
    const input = await body(request);
    return json({ payout: await failPayout(administrator.id, params.id, input.reason) });
  } catch (error) {
    return adminFailure(error);
  }
}
