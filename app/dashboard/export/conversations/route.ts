/**
 * GET /dashboard/export/conversations -- the workspace's workbench
 * conversations as JSON (agent-first-proposal.md 10): every turn as the
 * server recorded it. Session-gated: a workspace exports its own and
 * nothing else; never cached.
 */
import { NextResponse } from 'next/server';
import { exportConversations } from '@/lib/application/privacy';
import { currentSession } from '@/lib/http/session';

export const runtime = 'nodejs';

export async function GET(): Promise<NextResponse> {
  const session = await currentSession();
  if (!session) return new NextResponse('sign in to export your conversations', { status: 401 });
  const conversations = await exportConversations(session.workspace.id);
  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(JSON.stringify({ exportedAt: new Date().toISOString(), conversations }, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="re0-conversations-${stamp}.json"`,
      'cache-control': 'private, no-store',
    },
  });
}
