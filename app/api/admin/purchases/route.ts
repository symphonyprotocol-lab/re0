import type { NextRequest } from 'next/server';
import { apiAdministrator } from '@/lib/http/admin';
import { listOrCsv, PURCHASES_CSV, SUBSCRIPTIONS_CSV } from '@/lib/http/admin-lists';
import { purchasesView } from '@/lib/domain/admin-lists';
import { listPurchases, listSubscriptions } from '@/lib/services/admin-purchases';

/** Payments (`tab=transactions`, default) or subscriptions (`tab=subscriptions`); `q`, `status`, `kind`, `period`, `sort`, `size`, `page`; `format=csv`. */
export async function GET(request: NextRequest) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const view = purchasesView(request.nextUrl.searchParams);
  return view.tab === 'subscriptions'
    ? listOrCsv(request, (all) => listSubscriptions(view, { all }), SUBSCRIPTIONS_CSV)
    : listOrCsv(request, (all) => listPurchases(view, { all }), PURCHASES_CSV);
}
