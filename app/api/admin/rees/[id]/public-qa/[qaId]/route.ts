import type { NextRequest } from 'next/server';
import { adminParams } from '@/lib/http/admin-params';
import { apiAdministrator } from '@/lib/http/admin';
import { body, fail, json } from '@/lib/http/respond';
import { adminSetPublicQa } from '@/lib/services/public-qa';

/** `{show}`: hides a published public answer (`false`) or restores a hidden one (`true`); 409 `stale` when it is no longer in that state. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string; qaId: string }> }) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const params = await adminParams(context.params);
  if (params instanceof Response) return params;
  const show = (await body(request)).show === true;
  return (await adminSetPublicQa(administrator.id, params.id, params.qaId, show)) ? json({ ok: true }) : fail('stale', 409);
}
