import type { NextRequest } from 'next/server';
import { apiAdministrator } from '@/lib/http/admin';
import { fail, json } from '@/lib/http/respond';
import { adminRee, reeAudit } from '@/lib/services/admin-rees';

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const id = (await context.params).id;
  const ree = await adminRee(id);
  return ree ? json({ ...ree, audit: await reeAudit(id) }) : fail('not_found', 404);
}
