import type { NextRequest } from 'next/server';
import { apiAdministrator } from '@/lib/http/admin';
import { body, fail, json } from '@/lib/http/respond';
import { adminFreezePublishing } from '@/lib/services/workspace-publish';

/** `{user_id, frozen}`: freezes or unfreezes an account's publishing (its links go unavailable, nothing new can be published). In the management log. */
export async function POST(request: NextRequest) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const input = await body(request);
  const userId = typeof input.user_id === 'string' && /^[0-9a-f-]{36}$/i.test(input.user_id) ? input.user_id : null;
  if (!userId || typeof input.frozen !== 'boolean') return fail('invalid_input', 400);
  return (await adminFreezePublishing(administrator.id, userId, input.frozen)) ? json({ ok: true }) : fail('stale', 409);
}
