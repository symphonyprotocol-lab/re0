import type { NextRequest } from 'next/server';
import { adminParams } from '@/lib/http/admin-params';
import { apiAdministrator } from '@/lib/http/admin';
import { body, fail, json } from '@/lib/http/respond';
import { adminCancelCompetition, adminHideCompetition } from '@/lib/services/competitions';

/**
 * `{action: 'cancel', reason}` takes a competition down before its results
 * (every open hold given back); `{action: 'hide' | 'restore'}` hides or
 * restores a published one's page. 409 `stale` when it is not in that
 * state. In the management log.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const params = await adminParams(context.params);
  if (params instanceof Response) return params;
  const input = await body(request);
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  const done =
    input.action === 'cancel'
      ? await adminCancelCompetition(administrator.id, params.id, reason)
      : input.action === 'hide' || input.action === 'restore'
        ? await adminHideCompetition(administrator.id, params.id, input.action === 'hide')
        : null;
  if (done === null) return fail('invalid_action', 400);
  return done ? json({ ok: true }) : fail('stale', 409);
}
