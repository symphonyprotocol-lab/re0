import type { NextRequest } from 'next/server';
import { apiAdministrator } from '@/lib/http/admin';
import { json } from '@/lib/http/respond';
import { ADMIN_COMPETITION_VIEWS, adminCompetitions, type AdminCompetitionView } from '@/lib/services/competitions';

/** `GET ?view=active|reported|big_changes|all&q=` → `{items}`: the console's competitions. */
export async function GET(request: NextRequest) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const params = request.nextUrl.searchParams;
  const view = (ADMIN_COMPETITION_VIEWS as readonly string[]).includes(params.get('view') ?? '') ? (params.get('view') as AdminCompetitionView) : 'all';
  return json({ items: await adminCompetitions({ view, q: params.get('q') }) });
}
