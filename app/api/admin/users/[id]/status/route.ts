import type { NextRequest } from 'next/server';
import { apiAdministrator } from '@/lib/http/admin';
import { adminFailure } from '@/lib/http/admin-lists';
import { body, fail, json } from '@/lib/http/respond';
import { setUserDisabled } from '@/lib/services/admin-users';

/** `{ disabled: true | false }`: disable (signs the user out everywhere) or restore. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const input = await body(request);
  if (typeof input.disabled !== 'boolean') return fail('disabled', 422);
  try {
    await setUserDisabled(administrator.id, (await context.params).id, input.disabled);
    return json({ disabled: input.disabled });
  } catch (error) {
    return adminFailure(error);
  }
}
