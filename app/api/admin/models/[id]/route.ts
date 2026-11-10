import type { NextRequest } from 'next/server';
import { adminParams } from '@/lib/http/admin-params';
import { apiAdministrator } from '@/lib/http/admin';
import { body, fail, json } from '@/lib/http/respond';
import { AdminInputError } from '@/lib/services/admin';
import { updateModelConfig } from '@/lib/services/models';

/** Edit an entry; an enabled one keeps its model and endpoint (`locked`). */
export async function PUT(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const params = await adminParams(context.params);
  if (params instanceof Response) return params;
  try {
    return json({ config: await updateModelConfig(administrator.id, params.id, await body(request)) });
  } catch (error) {
    if (error instanceof AdminInputError) return fail(error.code, error.code === 'not_found' ? 404 : error.code === 'locked' ? 409 : 422);
    throw error;
  }
}
