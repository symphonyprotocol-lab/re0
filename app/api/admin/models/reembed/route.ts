import type { NextRequest } from 'next/server';
import { apiAdministrator } from '@/lib/http/admin';
import { body, fail, json } from '@/lib/http/respond';
import { AdminInputError } from '@/lib/services/admin';
import { activateModelConfig } from '@/lib/services/models';

/**
 * Switching the embedding model (2.5): creates a full re-embed job. Step 1
 * records the request and answers with a placeholder; the job, its progress
 * (`GET`) and the final switch come in step 5.
 */
export async function POST(request: NextRequest) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  try {
    const result = await activateModelConfig(administrator.id, String((await body(request)).to ?? ''));
    return json({ ...result, job: result.reembed ? { status: 'placeholder' } : null }, result.reembed ? 202 : 200);
  } catch (error) {
    if (error instanceof AdminInputError) return fail(error.code, 404);
    throw error;
  }
}

export async function GET(request: NextRequest) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  return json({ job: null });
}
