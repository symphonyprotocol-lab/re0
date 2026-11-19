import type { NextRequest } from 'next/server';
import { adminParams } from '@/lib/http/admin-params';
import { apiAdministrator } from '@/lib/http/admin';
import { body, fail, json } from '@/lib/http/respond';
import { adminReviewQuote } from '@/lib/services/posts';

/** `{action: 'keep' | 'hide_answers'}`: reviews a post quoting a taken-down one; 409 `stale` when it no longer waits. In the management log. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const params = await adminParams(context.params);
  if (params instanceof Response) return params;
  const action = (await body(request)).action;
  if (action !== 'keep' && action !== 'hide_answers') return fail('invalid_action', 422);
  return (await adminReviewQuote(administrator.id, params.id, action)) ? json({ ok: true }) : fail('stale', 409);
}
