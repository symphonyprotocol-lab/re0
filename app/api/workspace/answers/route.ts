import type { NextRequest } from 'next/server';
import { json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { ownedReeRows, workspaceAnswers, workspaceQuery } from '@/lib/services/statistics';

/** Successful answers across my Rees, by Ree or record by record: `ree`, `view`, `period`, `date`, `start`, `end`, `q`, `size`, `page`. */
export async function GET(request: NextRequest) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const rees = await ownedReeRows(user.id);
  return json(await workspaceAnswers(user.id, workspaceQuery(request.nextUrl.searchParams, rees.map((ree) => ree.id), true)));
}
