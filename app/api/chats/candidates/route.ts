import type { NextRequest } from 'next/server';
import { json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { pickerCandidates } from '@/lib/services/conversations';

/** The participant picker: the user's own Rees and public ones matching `q`; `include` keeps chosen ones in the list. */
export async function GET(request: NextRequest) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const params = request.nextUrl.searchParams;
  const include = (params.get('include') ?? '').split(',').filter((id) => /^[0-9a-f-]{36}$/i.test(id)).slice(0, 5);
  return json({ items: await pickerCandidates(user.id, params.get('q') ?? '', include) });
}
