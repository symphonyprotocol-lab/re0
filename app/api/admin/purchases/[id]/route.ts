import type { NextRequest } from 'next/server';
import { apiAdministrator } from '@/lib/http/admin';
import { fail, json } from '@/lib/http/respond';
import { purchaseDetail } from '@/lib/services/admin-purchases';

/** One payment, read-only: its grant, ledger rows, and every Paddle notification about it. */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const detail = await purchaseDetail((await context.params).id);
  return detail ? json(detail) : fail('not_found', 404);
}
