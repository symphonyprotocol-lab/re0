import type { NextRequest } from 'next/server';
import { fail, json } from '@/lib/http/respond';
import { rateLimited } from '@/lib/http/rate-limit';
import { apiUser } from '@/lib/http/session';
import { cancelCompetition } from '@/lib/services/competitions';

/** 取消 by the host: a draft, one in review, or an open one nobody entered; the deposit back. 409 `locked` otherwise. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const limited = await rateLimited('postAction', { userId: user.id, headers: request.headers });
  if (limited) return limited;
  const result = await cancelCompetition(user.id, (await params).id);
  if (result.ok) return json({ ok: true });
  return fail(result.error, result.error === 'not_found' ? 404 : 409);
}
