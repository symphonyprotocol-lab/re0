import type { NextRequest } from 'next/server';
import { apiAdministrator } from '@/lib/http/admin';
import { UUID } from '@/lib/http/admin-params';
import { body, fail, json } from '@/lib/http/respond';
import { isModelKind } from '@/lib/domain/models';
import { AdminInputError } from '@/lib/services/admin';
import { addToChain, saveChain } from '@/lib/services/models';

export const maxDuration = 60;

function failed(error: unknown) {
  if (error instanceof AdminInputError) return fail(error.code, error.code === 'not_found' ? 404 : error.code === 'stale' ? 409 : 422);
  throw error;
}

/** `{ kind, audience?, entries: [{ id, active }] }`: the list in its new order, entries paused or removed. */
export async function PUT(request: NextRequest) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const input = await body(request);
  if (!isModelKind(input.kind)) return fail('kind', 422);
  try {
    return json({ chain: await saveChain(administrator.id, input.kind, input.audience, input.entries) });
  } catch (error) {
    return failed(error);
  }
}

/** `{ kind, audience?, id }`: adds an entry as the list's last backup, after a probe of it succeeds. */
export async function POST(request: NextRequest) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const input = await body(request);
  if (!isModelKind(input.kind)) return fail('kind', 422);
  if (typeof input.id !== 'string' || !UUID.test(input.id)) return fail('not_found', 404);
  try {
    return json({ chain: await addToChain(administrator.id, input.kind, input.audience, input.id) });
  } catch (error) {
    return failed(error);
  }
}
