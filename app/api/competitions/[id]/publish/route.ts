import type { NextRequest } from 'next/server';
import { fail, json } from '@/lib/http/respond';
import { rateLimited } from '@/lib/http/rate-limit';
import { apiUser } from '@/lib/http/session';
import { publishCompetition } from '@/lib/services/competitions';

export const maxDuration = 120;

/** 公布结果 before the review period ends: the host's, in review. 409 `stale` otherwise. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const limited = await rateLimited('postAction', { userId: user.id, headers: request.headers });
  if (limited) return limited;
  return (await publishCompetition((await params).id, new Date(), { hostId: user.id })) ? json({ ok: true }) : fail('stale', 409);
}
