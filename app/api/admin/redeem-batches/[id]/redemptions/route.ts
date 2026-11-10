import type { NextRequest } from 'next/server';
import { apiAdministrator } from '@/lib/http/admin';
import { listOrCsv, redeemRedemptionsCsv } from '@/lib/http/admin-lists';
import { fail } from '@/lib/http/respond';
import { redeemBatchView } from '@/lib/domain/admin-lists';
import { getBatch, listRedemptions } from '@/lib/services/admin-redeem';

/** A batch's redemptions, newest first: `q` (user name, email, id, or a code's last four), `size`, `page`; `format=csv`. */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const batch = await getBatch((await context.params).id);
  if (!batch) return fail('not_found', 404);
  const view = redeemBatchView(request.nextUrl.searchParams);
  return listOrCsv(request, (all) => listRedemptions(batch.id, view, { all }), redeemRedemptionsCsv(batch));
}
