import type { NextRequest } from 'next/server';
import { apiAdministrator } from '@/lib/http/admin';
import { fail, json } from '@/lib/http/respond';
import { payoutDetail } from '@/lib/services/payouts';

/** One request with the user, their identity state and tax form, and whether it may be approved or paid. */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const { id } = await context.params;
  const detail = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? await payoutDetail(id) : null;
  return detail ? json(detail) : fail('not_found', 404);
}
