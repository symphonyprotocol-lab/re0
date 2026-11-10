import type { NextRequest } from 'next/server';
import { adminParams } from '@/lib/http/admin-params';
import { apiAdministrator } from '@/lib/http/admin';
import { fail, json } from '@/lib/http/respond';
import { verificationDetail } from '@/lib/services/roles';

/** One application: statement, links, the snapshot it was submitted with, today's figures, public Rees. */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const params = await adminParams(context.params);
  if (params instanceof Response) return params;
  const detail = await verificationDetail(params.id);
  return detail ? json(detail) : fail('not_found', 404);
}
