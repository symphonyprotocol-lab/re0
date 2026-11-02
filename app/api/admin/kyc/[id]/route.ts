import type { NextRequest } from 'next/server';
import { apiAdministrator } from '@/lib/http/admin';
import { fail, json } from '@/lib/http/respond';
import { kycDetail } from '@/lib/services/kyc';

/** One record with the user, the reviewer, whether it is the user's newest, and the user's other records. */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const { id } = await context.params;
  const detail = /^[0-9a-f-]{36}$/i.test(id) ? await kycDetail(id) : null;
  return detail ? json(detail) : fail('not_found', 404);
}
