import type { NextRequest } from 'next/server';
import { apiAdministrator } from '@/lib/http/admin';
import { fail, json } from '@/lib/http/respond';
import { AdminInputError } from '@/lib/services/admin';
import { probeModelConfig } from '@/lib/services/models';

export const maxDuration = 60;

/** Sends one real request to the endpoint as configured. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  try {
    return json(await probeModelConfig(administrator.id, (await context.params).id));
  } catch (error) {
    if (error instanceof AdminInputError) return fail(error.code, 404);
    throw error;
  }
}
