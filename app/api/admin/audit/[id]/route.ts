import type { NextRequest } from 'next/server';
import { apiAdministrator } from '@/lib/http/admin';
import { fail, json } from '@/lib/http/respond';
import { auditEntry } from '@/lib/services/admin-audit';

/** One audit row with its before and after. */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const entry = await auditEntry((await context.params).id);
  return entry ? json(entry) : fail('not_found', 404);
}
