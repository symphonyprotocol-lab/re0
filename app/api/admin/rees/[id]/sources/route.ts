import type { NextRequest } from 'next/server';
import { adminParams } from '@/lib/http/admin-params';
import { apiAdministrator } from '@/lib/http/admin';
import { fail, json } from '@/lib/http/respond';
import { adminRee, adminReeSources, sourceFilter } from '@/lib/services/admin-rees';

/** A Ree's sources, 20 a page: `sourceQ`, `sourceStatus`, `sourcePage`. */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const params = await adminParams(context.params);
  if (params instanceof Response) return params;
  const { id } = params;
  if (!(await adminRee(id))) return fail('not_found', 404);
  return json(await adminReeSources(id, sourceFilter(request.nextUrl.searchParams)));
}
