import type { NextRequest } from 'next/server';
import { adminParams } from '@/lib/http/admin-params';
import { apiAdministrator } from '@/lib/http/admin';
import { listOrCsv, redeemRedemptionsCsv } from '@/lib/http/admin-lists';
import { fail } from '@/lib/http/respond';
import { redeemBatchView } from '@/lib/domain/admin-lists';
import { getBatch, listRedemptions } from '@/lib/services/admin-redeem';

/** A batch's redemptions, newest first: `q` (user name, email, id, or a code's last four), `size`, `page`; `format=csv`. */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const params = await adminParams(context.params);
  if (params instanceof Response) return params;
  const batch = await getBatch(administrator, params.id);
  if (!batch) return fail('not_found', 404);
  const view = redeemBatchView(request.nextUrl.searchParams);
  return listOrCsv(request, administrator, (all) => listRedemptions(administrator, batch.id, view, { all }), redeemRedemptionsCsv(batch));
}
