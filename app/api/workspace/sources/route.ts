import type { NextRequest } from 'next/server';
import { json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { ownedReeRows, workspaceQuery, workspaceSources } from '@/lib/services/statistics';

/** Sources across all my Rees: `ree`, `status`, `kind`, `q`, `size`, `page`. */
export async function GET(request: NextRequest) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const rees = await ownedReeRows(user.id);
  return json(await workspaceSources(user.id, workspaceQuery(request.nextUrl.searchParams, rees.map((ree) => ree.id), false)));
}
