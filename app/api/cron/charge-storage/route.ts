import type { NextRequest } from 'next/server';
import { fail, json } from '@/lib/http/respond';
import { timingSafeEqual } from '@/lib/infra/crypto/tokens';
import { chargeStorage } from '@/lib/services/storage-billing';

export const maxDuration = 300;

/**
 * Vercel Cron (vercel.json, daily): bills every owner's knowledge storage
 * since it was last billed (docs/audit/credit-import-audit.md P4). Vercel
 * sends `Authorization: Bearer $CRON_SECRET`; anything else is refused, and
 * with no secret configured the route stays shut. Idempotent: a second run
 * the same day finds nothing an hour old to bill.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const presented = request.headers.get('authorization') ?? '';
  if (!secret || !timingSafeEqual(presented, `Bearer ${secret}`)) return fail('unauthorized', 401);
  const charged = await chargeStorage();
  return json({ owners: new Set(charged.map((charge) => charge.userId)).size, credits: charged.reduce((sum, charge) => sum + charge.credits, 0) });
}
