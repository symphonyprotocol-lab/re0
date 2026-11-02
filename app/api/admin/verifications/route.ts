import type { NextRequest } from 'next/server';
import { apiAdministrator } from '@/lib/http/admin';
import { listOrCsv, VERIFICATIONS_CSV } from '@/lib/http/admin-lists';
import { verificationsView } from '@/lib/domain/admin-lists';
import { listVerifications } from '@/lib/services/roles';

/** Applications: `q`, `status` (pending by default, oldest first), `size`, `page`; `format=csv`. */
export async function GET(request: NextRequest) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const view = verificationsView(request.nextUrl.searchParams);
  return listOrCsv(request, (all) => listVerifications(view, { all }), VERIFICATIONS_CSV);
}
