import type { NextRequest } from 'next/server';
import { fail, json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { db } from '@/lib/infra/db';
import { ownedRee } from '@/lib/services/rees';
import { reeStatistics, statisticsQuery } from '@/lib/services/statistics';

/** One Ree's usage: `period`, `date`, `start`, `end`, `view`, `q`, `size`, `page`. An official owner's income stays in the console (2.7). */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const ree = await ownedRee(db(), user.id, (await context.params).id);
  if (!ree) return fail('not_found', 404);
  return json(await reeStatistics(ree.id, statisticsQuery(request.nextUrl.searchParams), { withIncome: user.role !== 'official' }));
}
