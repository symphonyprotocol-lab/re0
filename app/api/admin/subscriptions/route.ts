import type { NextRequest } from 'next/server';
import { apiAdministrator } from '@/lib/http/admin';
import { listOrCsv, SUBSCRIPTIONS_CSV } from '@/lib/http/admin-lists';
import { purchasesView } from '@/lib/domain/admin-lists';
import { listSubscriptions } from '@/lib/services/admin-purchases';

/** The subscriptions view on its own path (3): the same filters as `/api/admin/purchases?tab=subscriptions`. */
export async function GET(request: NextRequest) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const params = new URLSearchParams(request.nextUrl.searchParams);
  params.set('tab', 'subscriptions');
  const view = purchasesView(params);
  return listOrCsv(request, (all) => listSubscriptions(view, { all }), SUBSCRIPTIONS_CSV);
}
