import type { NextRequest } from 'next/server';
import { adminParams } from '@/lib/http/admin-params';
import { apiAdministrator } from '@/lib/http/admin';
import { fail, json } from '@/lib/http/respond';
import { AdminInputError } from '@/lib/services/admin';
import { removeRateLimitExemption } from '@/lib/services/rate-limit-settings';

type Context = { params: Promise<{ userId: string }> };

export async function DELETE(request: NextRequest, context: Context) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const params = await adminParams(context.params);
  if (params instanceof Response) return params;
  try {
    await removeRateLimitExemption(administrator.id, params.userId);
    return json({ removed: true });
  } catch (error) {
    if (error instanceof AdminInputError) return fail(error.code, 404);
    throw error;
  }
}
