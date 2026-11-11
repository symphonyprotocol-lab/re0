import type { NextRequest } from 'next/server';
import { apiAdministrator } from '@/lib/http/admin';
import { adminFailure, listOrCsv, REDEEM_BATCHES_CSV } from '@/lib/http/admin-lists';
import { body, json } from '@/lib/http/respond';
import { redeemBatchesView } from '@/lib/domain/admin-lists';
import { createBatch, listBatches } from '@/lib/services/admin-redeem';

/** Redeem code batches: `q` (name, a whole code, or its last four), `status`, `kind`, `period`, `sort`, `size`, `page`; `format=csv`. */
export async function GET(request: NextRequest) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const view = redeemBatchesView(request.nextUrl.searchParams);
  return listOrCsv(request, administrator, (all) => listBatches(administrator, view, { all }), REDEEM_BATCHES_CSV);
}

/**
 * A new batch (docs/design/redeem-codes.md 7): `{ name, note?, kind, planMonths | packQuantity,
 * codeCount, maxRedemptions (null = unlimited, one code only), perUserLimit?, prefix?, customCode?,
 * startsAt?, expiresAt? }`. Answers with the batch and its plaintext codes.
 */
export async function POST(request: NextRequest) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  try {
    return json(await createBatch(administrator.id, await body(request)), 201);
  } catch (error) {
    return adminFailure(error);
  }
}
