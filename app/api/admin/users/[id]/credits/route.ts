import type { NextRequest } from 'next/server';
import { apiAdministrator } from '@/lib/http/admin';
import { adminFailure } from '@/lib/http/admin-lists';
import { body, json } from '@/lib/http/respond';
import { adjustCredits } from '@/lib/services/admin-users';

/** `{ bucket: 'pack' | 'plan', direction: 'grant' | 'deduct', amount, reason }`: never below zero, audited, the user notified. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  try {
    return json(await adjustCredits(administrator.id, (await context.params).id, await body(request)));
  } catch (error) {
    return adminFailure(error);
  }
}
