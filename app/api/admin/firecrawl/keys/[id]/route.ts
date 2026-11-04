import type { NextRequest } from 'next/server';
import { apiAdministrator } from '@/lib/http/admin';
import { body, fail, json } from '@/lib/http/respond';
import { AdminInputError } from '@/lib/services/admin';
import { deleteFirecrawlKey, saveFirecrawlKey } from '@/lib/services/firecrawl-keys';

type Context = { params: Promise<{ id: string }> };

export async function PUT(request: NextRequest, context: Context) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  try {
    return json({ key: await saveFirecrawlKey(administrator.id, (await context.params).id, await body(request)) });
  } catch (error) {
    if (error instanceof AdminInputError) return fail(error.code, error.code === 'not_found' ? 404 : error.code === 'duplicate' ? 409 : 422);
    throw error;
  }
}

export async function DELETE(request: NextRequest, context: Context) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  try {
    await deleteFirecrawlKey(administrator.id, (await context.params).id);
    return json({ deleted: true });
  } catch (error) {
    if (error instanceof AdminInputError) return fail(error.code, 404);
    throw error;
  }
}
