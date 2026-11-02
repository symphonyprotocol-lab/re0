import type { NextRequest } from 'next/server';
import { LIST_PAGE_SIZES } from '@/lib/constants';
import { parseActivity } from '@/lib/http/billing';
import { json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { listEntries } from '@/lib/services/billing';

/** `GET /api/billing/entries?activity=all|spend|income&page=&size=20|50|100`: the ledger, `{items, total, page, size}`. */
export async function GET(request: NextRequest) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  return json(await listEntries(user.id, parseActivity(request.nextUrl.searchParams, LIST_PAGE_SIZES)));
}
