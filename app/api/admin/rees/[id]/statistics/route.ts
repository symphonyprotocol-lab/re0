import type { NextRequest } from 'next/server';
import { apiAdministrator } from '@/lib/http/admin';
import { fail, json } from '@/lib/http/respond';
import { adminRee } from '@/lib/services/admin-rees';
import { reeStatistics, statisticsQuery } from '@/lib/services/statistics';

/** The console's statistics tab: the owner's view, income included whatever the owner's role. */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const id = (await context.params).id;
  if (!(await adminRee(id))) return fail('not_found', 404);
  return json(await reeStatistics(id, statisticsQuery(request.nextUrl.searchParams), { withIncome: true }));
}
