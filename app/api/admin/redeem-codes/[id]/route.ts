import type { NextRequest } from 'next/server';
import { adminParams } from '@/lib/http/admin-params';
import { apiAdministrator } from '@/lib/http/admin';
import { adminFailure } from '@/lib/http/admin-lists';
import { body, json } from '@/lib/http/respond';
import { setCodeStatus } from '@/lib/services/admin-redeem';

/** `{ status: 'active' | 'disabled' }`: one code off or back on; audited. */
export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const params = await adminParams(context.params);
  if (params instanceof Response) return params;
  try {
    return json(await setCodeStatus(administrator.id, params.id, (await body(request)).status));
  } catch (error) {
    return adminFailure(error);
  }
}
