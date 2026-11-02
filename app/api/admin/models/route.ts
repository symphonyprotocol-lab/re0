import type { NextRequest } from 'next/server';
import { apiAdministrator } from '@/lib/http/admin';
import { body, fail, json } from '@/lib/http/respond';
import { AdminInputError } from '@/lib/services/admin';
import { createModelConfig, listModelConfigs } from '@/lib/services/models';

export async function GET(request: NextRequest) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  return json(await listModelConfigs());
}

/** A new entry; always starts inactive. */
export async function POST(request: NextRequest) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  try {
    return json({ config: await createModelConfig(administrator.id, await body(request)) }, 201);
  } catch (error) {
    if (error instanceof AdminInputError) return fail(error.code, 422);
    throw error;
  }
}
