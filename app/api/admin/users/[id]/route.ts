import type { NextRequest } from 'next/server';
import { apiAdministrator } from '@/lib/http/admin';
import { fail, json } from '@/lib/http/respond';
import { adminUser, userEntries, userPurchases, userRees, userRoles } from '@/lib/services/admin-users';

/** Everything about one user: summary, roles, ledger (`page`), purchases, Rees. */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const id = (await context.params).id;
  const user = await adminUser(id);
  if (!user) return fail('not_found', 404);
  const page = Number(request.nextUrl.searchParams.get('page')) || 1;
  const [roles, entries, purchases, rees] = await Promise.all([userRoles(id), userEntries(id, page, 20), userPurchases(id), userRees(id)]);
  return json({ user, roles, entries, purchases, rees });
}
