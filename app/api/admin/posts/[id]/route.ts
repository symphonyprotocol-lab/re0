import type { NextRequest } from 'next/server';
import { adminParams } from '@/lib/http/admin-params';
import { apiAdministrator } from '@/lib/http/admin';
import { body, fail, json } from '@/lib/http/respond';
import { adminSetPost } from '@/lib/services/posts';

/** `{show}`: takes a public post down (`false`) or restores one an administrator or reports took down (`true`); 409 `stale` when it is no longer in that state. In the management log. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const params = await adminParams(context.params);
  if (params instanceof Response) return params;
  const show = (await body(request)).show === true;
  return (await adminSetPost(administrator.id, params.id, show)) ? json({ ok: true }) : fail('stale', 409);
}
