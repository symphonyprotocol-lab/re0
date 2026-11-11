import type { NextRequest } from 'next/server';
import { apiAdministrator } from '@/lib/http/admin';
import { listOrCsv, PAYOUTS_CSV } from '@/lib/http/admin-lists';
import { payoutHistoryView } from '@/lib/domain/admin-lists';
import { listPayouts } from '@/lib/services/payouts';

/** 提现记录: every request in its five states; `q`, `status`, `period`, `sort`, `size`, `page`; `format=csv`. */
export async function GET(request: NextRequest) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const view = payoutHistoryView(request.nextUrl.searchParams);
  return listOrCsv(request, administrator, (all) => listPayouts(view, 'history', { all }), PAYOUTS_CSV);
}
