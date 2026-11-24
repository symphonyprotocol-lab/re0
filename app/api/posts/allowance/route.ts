import type { NextRequest } from 'next/server';
import { json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { postAllowance } from '@/lib/services/posts';

/** → `{balance, baseFee, maxAnswers, maxCost, postedToday, dailyLimit}`: what the composer says before posting (per-answer billing); `dailyLimit` is `null` for an account whose `post` exemption lifts it. */
export async function GET(request: NextRequest) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  return json(await postAllowance(user.id));
}
