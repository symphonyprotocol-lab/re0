import type { NextRequest } from 'next/server';
import { adminParams } from '@/lib/http/admin-params';
import { apiAdministrator } from '@/lib/http/admin';
import { body, fail, json } from '@/lib/http/respond';
import { adminRestore, adminTakeDown } from '@/lib/services/workspace-publish';

/** `{action: 'takedown', note?}` revokes a public file for good and blocklists its bytes; `{action: 'restore'}` lifts a suspension reports caused. 409 `stale` when it is no longer in that state. In the management log. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const params = await adminParams(context.params);
  if (params instanceof Response) return params;
  const input = await body(request);
  const note = typeof input.note === 'string' ? input.note.trim().slice(0, 500) || null : null;
  if (input.action === 'takedown') return (await adminTakeDown(administrator.id, params.id, note)) ? json({ ok: true }) : fail('stale', 409);
  if (input.action === 'restore') return (await adminRestore(administrator.id, params.id)) ? json({ ok: true }) : fail('stale', 409);
  return fail('invalid_action', 400);
}
