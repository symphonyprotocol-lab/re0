import type { NextRequest } from 'next/server';
import { apiAdministrator } from '@/lib/http/admin';
import { adminFailure } from '@/lib/http/admin-lists';
import { body, json } from '@/lib/http/respond';
import { decideKyc } from '@/lib/services/kyc';

/** Reject the newest pending submission: `{ reason }`, 3–300 characters, which the user reads. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  try {
    const input = await body(request);
    return json({ record: await decideKyc(administrator.id, (await context.params).id, 'rejected', input) });
  } catch (error) {
    return adminFailure(error);
  }
}
