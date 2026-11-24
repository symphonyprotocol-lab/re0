import type { NextRequest } from 'next/server';
import { adminParams } from '@/lib/http/admin-params';
import { apiAdministrator } from '@/lib/http/admin';
import { body, fail, json } from '@/lib/http/respond';
import { adminDisqualify } from '@/lib/services/competitions';

/** 取消参赛资格 `{reason}`: before the results its hold back; after them out of the ranking. In the management log. */
export async function POST(request: NextRequest, context: { params: Promise<{ entryId: string }> }) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const params = await adminParams(context.params);
  if (params instanceof Response) return params;
  const input = await body(request);
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  return (await adminDisqualify(administrator.id, params.entryId, reason)) ? json({ ok: true }) : fail('stale', 409);
}
