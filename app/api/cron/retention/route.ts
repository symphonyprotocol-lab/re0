/**
 * The hourly retention run (agent-first-proposal.md 7.9 part 4, 10).
 *
 * Clears the bodies of A2A tasks past their 30 days -- inbound tasks and
 * outbound delegations, with the text the delegation actions sent -- down
 * to ids, states and metering, and deletes the private assets of every
 * workspace that set a retention period, through the ordinary deletion
 * whose cleanup the drain runs. Vercel Cron calls it with
 * `Authorization: Bearer $CRON_SECRET`; anything else is a 401, like the
 * drain and the anchor routes.
 */
import { NextResponse } from 'next/server';
import { runRetention } from '@/lib/application/privacy';

export const maxDuration = 300;

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return new NextResponse(null, { status: 401 });
  }
  const outcome = await runRetention();
  return NextResponse.json(outcome, { headers: { 'cache-control': 'no-store' } });
}
