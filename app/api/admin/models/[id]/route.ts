import type { NextRequest } from 'next/server';
import { adminParams } from '@/lib/http/admin-params';
import { apiAdministrator } from '@/lib/http/admin';
import { body, fail, json } from '@/lib/http/respond';
import { AdminInputError } from '@/lib/services/admin';
import { deleteModelConfig, ModelInUseError, updateModelConfig } from '@/lib/services/models';

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

/** Delete an entry nothing uses (`in_use` names each list to take it out of first); its history stays. */
export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const params = await adminParams(context.params);
  if (params instanceof Response) return params;
  try {
    await deleteModelConfig(administrator.id, params.id);
    return json({ deleted: true });
  } catch (error) {
    if (error instanceof ModelInUseError) return fail(error.code, 409, { uses: error.uses });
    if (error instanceof AdminInputError) return fail(error.code, error.code === 'not_found' ? 404 : 422);
    throw error;
  }
}
