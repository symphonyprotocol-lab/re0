import type { NextRequest } from 'next/server';
import { adminParams } from '@/lib/http/admin-params';
import { apiAdministrator } from '@/lib/http/admin';
import { adminFailure } from '@/lib/http/admin-lists';
import { body, json } from '@/lib/http/respond';
import { setUserPayoutMinimum } from '@/lib/services/payout-minimum';

/** `{ credits }` sets this user's own payout minimum, `{ credits: null }` returns them to the site-wide one; audited. */
export async function PUT(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const params = await adminParams(context.params);
  if (params instanceof Response) return params;
  try {
    return json(await setUserPayoutMinimum(administrator.id, params.id, await body(request)));
  } catch (error) {
    return adminFailure(error);
  }
}
