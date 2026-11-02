import type { NextRequest } from 'next/server';
import { apiAdministrator } from '@/lib/http/admin';
import { fail, json } from '@/lib/http/respond';
import { AdminInputError } from '@/lib/services/admin';
import { activateModelConfig } from '@/lib/services/models';

/** Generation and transcription switch now; embedding answers `reembed: true` (job placeholder, step 5). */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  try {
    return json(await activateModelConfig(administrator.id, (await context.params).id));
  } catch (error) {
    if (error instanceof AdminInputError) return fail(error.code, 404);
    throw error;
  }
}
