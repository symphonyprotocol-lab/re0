import type { NextRequest } from 'next/server';
import { apiAdministrator } from '@/lib/http/admin';
import { listOrCsv, REES_CSV } from '@/lib/http/admin-lists';
import { reesView } from '@/lib/domain/admin-lists';
import { listAdminRees } from '@/lib/services/admin-rees';

/** Every Ree: `q`, `status` (public, private, moderated), `sort`, `size`, `page`; `format=csv`. */
export async function GET(request: NextRequest) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const view = reesView(request.nextUrl.searchParams);
  return listOrCsv(request, administrator, (all) => listAdminRees(administrator, view, { all }), REES_CSV);
}
