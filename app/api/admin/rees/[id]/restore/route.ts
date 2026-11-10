import type { NextRequest } from 'next/server';
import { adminParams } from '@/lib/http/admin-params';
import { apiAdministrator } from '@/lib/http/admin';
import { adminFailure } from '@/lib/http/admin-lists';
import { body, json } from '@/lib/http/respond';
import { restoreRee } from '@/lib/services/admin-rees';

/** Restores a taken-down Ree to public; the owner is told. `{ reason }` 3–300. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const params = await adminParams(context.params);
  if (params instanceof Response) return params;
  try {
    await restoreRee(administrator.id, params.id, (await body(request)).reason);
    return json({ ok: true });
  } catch (error) {
    return adminFailure(error);
  }
}
