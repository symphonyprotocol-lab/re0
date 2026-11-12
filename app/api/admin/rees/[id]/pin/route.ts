import type { NextRequest } from 'next/server';
import { adminParams } from '@/lib/http/admin-params';
import { apiAdministrator } from '@/lib/http/admin';
import { adminFailure } from '@/lib/http/admin-lists';
import { body, json } from '@/lib/http/respond';
import { setReePin } from '@/lib/services/admin-rees';

/** Pins a Ree to the top of Discover at `{ order }` (1–999, 1 leads), or unpins it with `{ order: null }`; `{ reason }` optional, 3–300. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const params = await adminParams(context.params);
  if (params instanceof Response) return params;
  try {
    const input = await body(request);
    return json(await setReePin(administrator.id, params.id, input.order, input.reason));
  } catch (error) {
    return adminFailure(error);
  }
}
