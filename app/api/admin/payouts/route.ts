import type { NextRequest } from 'next/server';
import { apiAdministrator } from '@/lib/http/admin';
import { listOrCsv, PAYOUTS_CSV } from '@/lib/http/admin-lists';
import { payoutQueueView } from '@/lib/domain/admin-lists';
import { listPayouts } from '@/lib/services/payouts';

/** 提现审核: requests in progress (`status` all / pending / approved), oldest first; `format=csv`. */
export async function GET(request: NextRequest) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const view = payoutQueueView(request.nextUrl.searchParams);
  return listOrCsv(request, (all) => listPayouts(view, 'queue', { all }), PAYOUTS_CSV);
}
