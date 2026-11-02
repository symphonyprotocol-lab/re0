import type { NextRequest } from 'next/server';
import { apiAdministrator } from '@/lib/http/admin';
import { KYC_CSV, listOrCsv } from '@/lib/http/admin-lists';
import { kycView } from '@/lib/domain/admin-lists';
import { listKyc } from '@/lib/services/kyc';

/** KYC records: `q`, `status`, `period`, `sort` (oldest first by default), `size`, `page`; `format=csv`. */
export async function GET(request: NextRequest) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const view = kycView(request.nextUrl.searchParams);
  return listOrCsv(request, (all) => listKyc(view, { all }), KYC_CSV);
}
