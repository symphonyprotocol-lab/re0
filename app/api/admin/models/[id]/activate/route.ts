import type { NextRequest } from 'next/server';
import { apiAdministrator } from '@/lib/http/admin';
import { body, fail, json } from '@/lib/http/respond';
import { AdminInputError } from '@/lib/services/admin';
import { activateModelConfig } from '@/lib/services/models';

/** Generation switches for `{ audience: 'free' | 'plan' }`; omission keeps legacy Free activation. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const input = await body(request);
  const audience = input.audience ?? 'free';
  if (audience !== 'free' && audience !== 'plan') return fail('audience', 422);
  try {
    return json(await activateModelConfig(administrator.id, (await context.params).id, audience));
  } catch (error) {
    if (error instanceof AdminInputError) return fail(error.code, error.code === 'not_found' ? 404 : 422);
    throw error;
  }
}
