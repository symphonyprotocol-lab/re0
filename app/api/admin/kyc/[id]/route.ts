import type { NextRequest } from 'next/server';
import { adminParams } from '@/lib/http/admin-params';
import { apiAdministrator } from '@/lib/http/admin';
import { fail, json } from '@/lib/http/respond';
import { kycDetail } from '@/lib/services/kyc';

/** One record with the user, the reviewer, whether it is the user's newest, and the user's other records. */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const params = await adminParams(context.params);
  if (params instanceof Response) return params;
  const { id } = params;
  const detail = await kycDetail(id);
  return detail ? json(detail) : fail('not_found', 404);
}
