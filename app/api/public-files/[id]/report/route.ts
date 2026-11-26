import type { NextRequest } from 'next/server';
import { clientIp } from '@/lib/http/client-ip';
import { body, fail, json } from '@/lib/http/respond';
import { sameOrigin } from '@/lib/http/session';
import { PublishError, reportPublication } from '@/lib/services/workspace-publish';

/**
 * `POST {reason, note?}`: anyone reports a public file (docs/design/agent-workspace-p4.md
 * §2.8), no sign-in; one report per address and file, limited per address.
 * Same-origin only: the form is on its own page.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  if (!sameOrigin(request.headers)) return fail('cross_origin', 403);
  const { id } = await context.params;
  const input = await body(request);
  try {
    await reportPublication(id, clientIp(request.headers), { reason: input.reason, note: input.note });
    return json({ ok: true });
  } catch (error) {
    if (error instanceof PublishError) return fail(error.code, error.status);
    throw error;
  }
}
