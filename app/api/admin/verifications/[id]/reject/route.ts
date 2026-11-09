import type { NextRequest } from 'next/server';
import { apiAdministrator } from '@/lib/http/admin';
import { adminFailure } from '@/lib/http/admin-lists';
import { body, json } from '@/lib/http/respond';
import { decideVerification } from '@/lib/services/roles';

/** Reject: `{ reason }` is required and shown to the user; 30 days before they may apply again. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  try {
    const input = await body(request);
    return json({ request: await decideVerification(administrator.id, (await context.params).id, 'rejected', input.reason) });
  } catch (error) {
    return adminFailure(error);
  }
}
