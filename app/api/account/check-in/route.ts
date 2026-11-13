import { json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { checkIn } from '@/lib/services/check-in';

/** The task guide's 打卡: today's check-in (the day is the server's, UTC+8), paid once. */
export async function POST(request: Request) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const result = await checkIn(user.id);
  return json(result.ok ? { ok: true, credits: result.credits, status: result.status } : { ok: false, reason: result.reason, status: result.status }, result.ok ? 201 : 409);
}
