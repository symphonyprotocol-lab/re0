import type { NextRequest } from 'next/server';
import { json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { postAllowance } from '@/lib/services/posts';

/** → `{freeLeft, fee, postedToday}`: what the composer says about today's posts. */
export async function GET(request: NextRequest) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  return json(await postAllowance(user.id));
}
