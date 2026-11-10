import type { NextRequest } from 'next/server';
import { apiAdministrator } from '@/lib/http/admin';
import { adminFailure } from '@/lib/http/admin-lists';
import { body, fail, json } from '@/lib/http/respond';
import { getBatch, updateBatch } from '@/lib/services/admin-redeem';

/** One batch with its code and user counts. */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const batch = await getBatch((await context.params).id);
  return batch ? json(batch) : fail('not_found', 404);
}

/** `{ name?, note?, status?: 'active' | 'disabled', expiresAt?: ISO | null }`; target and limits never change. */
export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  try {
    return json(await updateBatch(administrator.id, (await context.params).id, await body(request)));
  } catch (error) {
    return adminFailure(error);
  }
}
