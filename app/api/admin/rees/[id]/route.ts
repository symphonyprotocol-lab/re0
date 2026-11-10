import type { NextRequest } from 'next/server';
import { adminParams } from '@/lib/http/admin-params';
import { apiAdministrator } from '@/lib/http/admin';
import { fail, json } from '@/lib/http/respond';
import { adminRee, reeAudit } from '@/lib/services/admin-rees';

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const params = await adminParams(context.params);
  if (params instanceof Response) return params;
  const { id } = params;
  const ree = await adminRee(administrator, id);
  return ree ? json({ ...ree, audit: await reeAudit(administrator, id) }) : fail('not_found', 404);
}
