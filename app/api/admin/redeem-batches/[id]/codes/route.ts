import type { NextRequest } from 'next/server';
import { adminParams } from '@/lib/http/admin-params';
import { apiAdministrator } from '@/lib/http/admin';
import { adminFailure, csvResponse, redeemCodesCsv, wantsCsv } from '@/lib/http/admin-lists';
import { fail, json } from '@/lib/http/respond';
import { redeemBatchView } from '@/lib/domain/admin-lists';
import { exportCodes, getBatch, listCodes } from '@/lib/services/admin-redeem';

/**
 * A batch's codes, masked: `q` (last four or a whole code), `status`
 * (`available`, `used_up`, `disabled`), `size`, `page`. `format=csv` is every
 * matching code in plaintext, and is audited as an export.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const params = await adminParams(context.params);
  if (params instanceof Response) return params;
  const { id } = params;
  const view = redeemBatchView(request.nextUrl.searchParams);
  try {
    if (wantsCsv(request)) {
      const { batch, rows } = await exportCodes(administrator.id, id, view);
      const csv = redeemCodesCsv(batch);
      return csvResponse(csv.name, csv.headers, rows.map(csv.row));
    }
    if (!(await getBatch(id))) return fail('not_found', 404);
    return json(await listCodes(id, view));
  } catch (error) {
    return adminFailure(error);
  }
}
