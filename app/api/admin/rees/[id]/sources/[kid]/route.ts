import type { NextRequest } from 'next/server';
import { apiAdministrator } from '@/lib/http/admin';
import { fail, json } from '@/lib/http/respond';
import { adminReeSource, sourceFilter } from '@/lib/services/admin-rees';

/** One source, read-only, with previous / next in the same filtered list. */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string; kid: string }> }) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const { id, kid } = await context.params;
  const source = await adminReeSource(id, kid, sourceFilter(request.nextUrl.searchParams));
  return source ? json(source) : fail('not_found', 404);
}
