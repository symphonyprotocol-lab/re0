import type { NextRequest } from 'next/server';
import { adminParams } from '@/lib/http/admin-params';
import { apiAdministrator } from '@/lib/http/admin';
import { fail, json } from '@/lib/http/respond';
import { AdminInputError } from '@/lib/services/admin';
import { clearModelCooldown } from '@/lib/services/models';

/** "解除冷却": requests may use the entry again at once. */
export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const params = await adminParams(context.params);
  if (params instanceof Response) return params;
  try {
    return json(await clearModelCooldown(administrator.id, params.id));
  } catch (error) {
    if (error instanceof AdminInputError) return fail(error.code, 404);
    throw error;
  }
}
