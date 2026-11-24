import type { NextRequest } from 'next/server';
import { adminParams } from '@/lib/http/admin-params';
import { apiAdministrator } from '@/lib/http/admin';
import { body, fail, json } from '@/lib/http/respond';
import { adminDisqualify } from '@/lib/services/competitions';

/**
 * 取消参赛资格 `{reason}` (required, 1–500): before the results its hold
 * back; after them out of the ranking, the movers told. 400
 * `invalid_reason`; 409 `stale` when the entry is no longer in or the
 * competition was cancelled. In the management log.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ entryId: string }> }) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const params = await adminParams(context.params);
  if (params instanceof Response) return params;
  const result = await adminDisqualify(administrator.id, params.entryId, (await body(request)).reason);
  if (result.ok) return json({ ok: true });
  if (result.error === 'invalid_reason') return fail('invalid_reason', 400);
  return fail(result.error, result.error === 'not_found' ? 404 : 409);
}
