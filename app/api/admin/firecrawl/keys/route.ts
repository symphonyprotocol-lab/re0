import type { NextRequest } from 'next/server';
import { apiAdministrator } from '@/lib/http/admin';
import { body, fail, json } from '@/lib/http/respond';
import { AdminInputError } from '@/lib/services/admin';
import { listFirecrawlKeys, saveFirecrawlKey } from '@/lib/services/firecrawl-keys';

export async function GET(request: NextRequest) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  return json(await listFirecrawlKeys());
}

export async function POST(request: NextRequest) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  try {
    return json({ key: await saveFirecrawlKey(administrator.id, null, await body(request)) }, 201);
  } catch (error) {
    if (error instanceof AdminInputError) return fail(error.code, error.code === 'duplicate' ? 409 : 422);
    throw error;
  }
}
