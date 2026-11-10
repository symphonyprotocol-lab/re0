import type { NextRequest } from 'next/server';
import { adminParams } from '@/lib/http/admin-params';
import { apiAdministrator } from '@/lib/http/admin';
import { isRoleAction } from '@/lib/domain/roles';
import { adminFailure } from '@/lib/http/admin-lists';
import { body, fail, json } from '@/lib/http/respond';
import { changeRole } from '@/lib/services/roles';

/** `{ action: 'official' | 'cancel_official' | 'revoke', reason }` (2.7). */
export async function PUT(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const params = await adminParams(context.params);
  if (params instanceof Response) return params;
  const input = await body(request);
  if (!isRoleAction(input.action)) return fail('action', 422);
  try {
    return json({ role: await changeRole(administrator.id, params.id, input.action, input.reason) });
  } catch (error) {
    return adminFailure(error);
  }
}
