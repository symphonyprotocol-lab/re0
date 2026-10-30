/**
 * GET /dashboard/export/a2a-tasks -- the workspace's A2A tasks as JSON
 * (agent-first-proposal.md 7.9, 10): the inbound tasks other agents started
 * with its keys and the outbound delegations it sent, with whatever bodies
 * are still inside their 30 days. Session-gated; never cached.
 */
import { NextResponse } from 'next/server';
import { exportA2aTasks } from '@/lib/application/privacy';
import { currentSession } from '@/lib/http/session';

export const runtime = 'nodejs';

export async function GET(): Promise<NextResponse> {
  const session = await currentSession();
  if (!session) return new NextResponse('sign in to export your A2A tasks', { status: 401 });
  const tasks = await exportA2aTasks(session.workspace.id);
  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(JSON.stringify({ exportedAt: new Date().toISOString(), ...tasks }, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="re0-a2a-tasks-${stamp}.json"`,
      'cache-control': 'private, no-store',
    },
  });
}
