import type { NextRequest } from 'next/server';
import { apiAdministrator } from '@/lib/http/admin';
import { listOrCsv, USERS_CSV } from '@/lib/http/admin-lists';
import { usersView } from '@/lib/domain/admin-lists';
import { listUsers } from '@/lib/services/admin-users';

/** Users: `q`, `status`, `role`, `membership`, `kyc`, `period`, `sort`, `size`, `page`; `format=csv` exports every match. */
export async function GET(request: NextRequest) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const view = usersView(request.nextUrl.searchParams);
  return listOrCsv(request, administrator, (all) => listUsers(view, { all }), USERS_CSV);
}
