import type { NextRequest } from 'next/server';
import { apiAdministrator } from '@/lib/http/admin';
import { adminFailure } from '@/lib/http/admin-lists';
import { body, json } from '@/lib/http/respond';
import { takeDownRee } from '@/lib/services/admin-rees';

/** Takes a public Ree down: private, not republishable by its owner, out of other people's conversations; the owner is told why. `{ reason }` 3–300. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  try {
    await takeDownRee(administrator.id, (await context.params).id, (await body(request)).reason);
    return json({ ok: true });
  } catch (error) {
    return adminFailure(error);
  }
}
