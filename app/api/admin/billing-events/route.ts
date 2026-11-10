import type { NextRequest } from 'next/server';
import { apiAdministrator } from '@/lib/http/admin';
import { json } from '@/lib/http/respond';
import { unmatchedBillingEvents } from '@/lib/services/billing';

/**
 * `GET /api/admin/billing-events`: Paddle notifications that matched no
 * checkout or subscription of ours and were not credited (review M5), with
 * their count. `?limit=` up to 200.
 */
export async function GET(request: NextRequest) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const limit = Number(request.nextUrl.searchParams.get('limit') ?? 50);
  return json(await unmatchedBillingEvents(Number.isFinite(limit) ? limit : 50));
}
