import type { NextRequest } from 'next/server';
import { fail, json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { hostReview } from '@/lib/services/competitions';

/** 复核: every answer with its AI scores and rationale; the host's alone, during review. 404 otherwise. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const review = await hostReview(user.id, (await params).id);
  return review ? json({ answers: review.answers, reviewEndsAt: review.competition.reviewEndsAt?.toISOString() ?? null }) : fail('not_found', 404);
}
