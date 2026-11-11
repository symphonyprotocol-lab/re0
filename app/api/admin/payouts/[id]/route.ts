import type { NextRequest } from 'next/server';
import { adminParams } from '@/lib/http/admin-params';
import { apiAdministrator } from '@/lib/http/admin';
import { fail, json } from '@/lib/http/respond';
import { payoutDetail } from '@/lib/services/payouts';

/** One request with the user, their identity state and tax form, and whether it may be approved or paid. */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const params = await adminParams(context.params);
  if (params instanceof Response) return params;
  const { id } = params;
  const detail = await payoutDetail(id);
  return detail ? json(detail) : fail('not_found', 404);
}
